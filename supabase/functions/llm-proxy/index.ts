import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

// ==================== 配置区 ====================
// 环境变量名不能以 SUPABASE_ 开头（Deno Deploy 限制）
const CORS_ORIGIN = Deno.env.get("APP_CORS_ORIGIN") || "*";
const LLM_API_KEY = Deno.env.get("APP_LLM_API_KEY") || "";
const PROJECT_URL = Deno.env.get("APP_PROJECT_URL") || "";
const SERVICE_ROLE_KEY = Deno.env.get("APP_SERVICE_ROLE_KEY") || "";
const MAX_REQUESTS_PER_MINUTE = 20;
const MAX_MESSAGE_LENGTH = 8000;
const MAX_TOTAL_MESSAGES = 20;
const FETCH_TIMEOUT_MS = 25000;

const corsHeaders = {
  "Access-Control-Allow-Origin": CORS_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ==================== 工具函数 ====================
function jsonResponse(body: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", ...extraHeaders },
  });
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

async function checkRateLimit(supabase: any, userId: string) {
  const windowStart = new Date(Date.now() - 60 * 1000).toISOString();
  await supabase.from("rate_limits").delete().lt("window_start", windowStart);

  const { data: existing } = await supabase
    .from("rate_limits")
    .select("*")
    .eq("user_id", userId)
    .single();

  if (!existing) {
    await supabase.from("rate_limits").insert({
      user_id: userId,
      request_count: 1,
      window_start: new Date().toISOString(),
    });
    return { allowed: true, remaining: MAX_REQUESTS_PER_MINUTE - 1 };
  }

  if (existing.request_count >= MAX_REQUESTS_PER_MINUTE) {
    return { allowed: false, remaining: 0, resetAt: existing.window_start };
  }

  await supabase
    .from("rate_limits")
    .update({ request_count: existing.request_count + 1 })
    .eq("user_id", userId);

  return {
    allowed: true,
    remaining: MAX_REQUESTS_PER_MINUTE - existing.request_count - 1,
  };
}

function validateMessages(messages: any[]) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { valid: false, error: "messages 必须是包含至少一条消息的对象数组" };
  }
  if (messages.length > MAX_TOTAL_MESSAGES) {
    return { valid: false, error: `对话轮次过多，最多支持 ${MAX_TOTAL_MESSAGES} 条消息` };
  }

  const allowedRoles = ["system", "user", "assistant"];
  for (const msg of messages) {
    if (!msg.role || !allowedRoles.includes(msg.role)) {
      return { valid: false, error: `非法角色: ${msg.role}` };
    }
    if (typeof msg.content !== "string") {
      return { valid: false, error: "消息内容必须是字符串" };
    }
    if (msg.content.length > MAX_MESSAGE_LENGTH) {
      return { valid: false, error: `单条消息超过 ${MAX_MESSAGE_LENGTH} 字符限制` };
    }
  }
  return { valid: true };
}

async function logRequest(
  supabase: any,
  userId: string | null,
  model: string,
  promptLen: number,
  respLen: number,
  status: string,
  errorMsg: string,
  latencyMs: number
) {
  try {
    await supabase.from("llm_logs").insert({
      user_id: userId,
      model,
      prompt_length: promptLen,
      response_length: respLen,
      status,
      error_msg: errorMsg?.substring(0, 500),
      latency_ms: latencyMs,
    });
  } catch (e) {
    console.error("日志写入失败:", e);
  }
}

// ==================== 主入口 ====================
serve(async (req) => {
  const startTime = Date.now();

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // 鉴权：解析并验证 JWT
  const authHeader = req.headers.get("authorization");
  if (!authHeader) {
    return jsonResponse({ error: "缺少 Authorization 头", code: "UNAUTHORIZED" }, 401);
  }

  // 使用 Service Role Key 创建服务端客户端
  const supabaseAdmin = createClient(PROJECT_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(
    authHeader.replace("Bearer ", "")
  );

  if (authError || !user) {
    return jsonResponse({ error: "登录已过期或无效", code: "UNAUTHORIZED" }, 401);
  }

  // 查用户资料，确认已审核通过
  const { data: profile, error: profileError } = await supabaseAdmin
    .from("profiles")
    .select("status, role")
    .eq("id", user.id)
    .single();

  if (profileError || !profile || profile.status !== "approved") {
    return jsonResponse({ error: "账号未审核通过或已被禁用", code: "FORBIDDEN" }, 403);
  }

  // 限流检查
  const rateCheck = await checkRateLimit(supabaseAdmin, user.id);
  if (!rateCheck.allowed) {
    await logRequest(supabaseAdmin, user.id, "", 0, 0, "rate_limited", "", Date.now() - startTime);
    return jsonResponse(
      { error: "请求过于频繁，请稍后再试", code: "RATE_LIMITED", retry_after: 60 },
      429
    );
  }

  // 解析并校验请求体
  let body: any;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "请求体必须是合法 JSON", code: "BAD_REQUEST" }, 400);
  }

  const { messages, model, temperature, max_tokens, stream } = body;
  const validation = validateMessages(messages);
  if (!validation.valid) {
    return jsonResponse({ error: validation.error, code: "BAD_REQUEST" }, 400);
  }

  // 调用 DeepSeek（带超时）
  try {
    const llmResponse = await fetchWithTimeout(
      "https://api.deepseek.com/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${LLM_API_KEY}`,
        },
        body: JSON.stringify({
          model: model || "deepseek-chat",
          messages,
          temperature: temperature ?? 0.5,
          max_tokens: max_tokens ?? 2000,
          stream: stream ?? false,
        }),
      },
      FETCH_TIMEOUT_MS
    );

    if (!llmResponse.ok) {
      const errBody = await llmResponse.text();
      throw new Error(`DeepSeek 返回 ${llmResponse.status}: ${errBody}`);
    }

    // 流式透传
    if (stream) {
      logRequest(
        supabaseAdmin,
        user.id,
        model || "deepseek-chat",
        JSON.stringify(messages).length,
        0,
        "success",
        "",
        Date.now() - startTime
      );

      return new Response(llmResponse.body, {
        headers: {
          ...corsHeaders,
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "X-RateLimit-Remaining": String(rateCheck.remaining),
        },
      });
    }

    // 非流式
    const data = await llmResponse.json();
    const responseLength = data?.choices?.[0]?.message?.content?.length || 0;

    logRequest(
      supabaseAdmin,
      user.id,
      model || "deepseek-chat",
      JSON.stringify(messages).length,
      responseLength,
      "success",
      "",
      Date.now() - startTime
    );

    return jsonResponse(data, 200, {
      "X-RateLimit-Remaining": String(rateCheck.remaining),
    });
  } catch (error: any) {
    const isTimeout = error.name === "AbortError";
    const errorMsg = isTimeout ? "LLM 服务响应超时，请稍后重试" : (error.message || "Unknown error");

    logRequest(
      supabaseAdmin,
      user.id,
      model || "deepseek-chat",
      JSON.stringify(messages).length,
      0,
      "error",
      errorMsg,
      Date.now() - startTime
    );

    return jsonResponse(
      { error: errorMsg, code: isTimeout ? "LLM_TIMEOUT" : "LLM_ERROR" },
      502
    );
  }
});
