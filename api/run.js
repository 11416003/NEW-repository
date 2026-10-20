import { authenticationError, jsonResponse } from "../lib/security.js";
import { rateLimitExceeded } from "../lib/rate-limit.js";
import { MODEL_CATALOG, OUTPUT_TOKEN_LIMITS, modelAllowedForRole } from "../lib/model-catalog.js";

const MAX_BODY_BYTES = 100_000;
const MAX_SYSTEM_CHARS = 20_000;
const MAX_USER_CHARS = 60_000;
const UPSTREAM_TIMEOUT_MS = 240_000;

function apiError(code, message, status) {
  return jsonResponse({ error: { code, message } }, status);
}

function upstreamFailure(status) {
  if (status === 401 || status === 403) {
    return apiError("provider_auth_failed", "後台供應商金鑰無效或沒有呼叫權限，請檢查 Vercel 環境變數。", 502);
  }
  if (status === 429) {
    return apiError("provider_rate_limited", "供應商目前回報用量或速率限制，請稍後重試並檢查帳戶額度。", 429);
  }
  if (status === 400 || status === 404) {
    return apiError("provider_rejected_request", "供應商拒絕此次請求；請確認模型仍可用且 API 帳戶有權限。", 502);
  }
  return apiError("provider_unavailable", "供應商服務暫時無法完成請求，請稍後重試。", 502);
}

async function callOpenAI(model, system, user, role, apiKey) {
  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: user });

  const body = {
    model,
    messages,
    max_completion_tokens: OUTPUT_TOKEN_LIMITS[role],
    store: false
  };
  if (role !== "B") body.reasoning_effort = "low";

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: "Bearer " + apiKey,
      "content-type": "application/json"
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) return { error: upstreamFailure(response.status) };

  const choice = result.choices && result.choices[0] ? result.choices[0] : {};
  const content = choice.message && choice.message.content;
  const text = Array.isArray(content)
    ? content.map((part) => typeof part.text === "string" ? part.text : "").join("")
    : (typeof content === "string" ? content : "");
  return {
    data: {
      text,
      finishReason: choice.finish_reason || "",
      inTok: Number(result.usage && result.usage.prompt_tokens) || 0,
      outTok: Number(result.usage && result.usage.completion_tokens) || 0
    }
  };
}

async function callGemini(model, system, user, role, apiKey) {
  const body = {
    contents: [{ role: "user", parts: [{ text: user }] }],
    generationConfig: { maxOutputTokens: OUTPUT_TOKEN_LIMITS[role] }
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };

  const url = "https://generativelanguage.googleapis.com/v1beta/models/"
    + encodeURIComponent(model) + ":generateContent";
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": apiKey
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) return { error: upstreamFailure(response.status) };

  const candidate = result.candidates && result.candidates[0] ? result.candidates[0] : {};
  const parts = candidate.content && Array.isArray(candidate.content.parts) ? candidate.content.parts : [];
  const usage = result.usageMetadata || {};
  return {
    data: {
      text: parts.map((part) => typeof part.text === "string" ? part.text : "").join(""),
      finishReason: candidate.finishReason || "",
      inTok: Number(usage.promptTokenCount) || 0,
      outTok: Number(usage.candidatesTokenCount) || 0
    }
  };
}

export default {
  async fetch(request) {
    if (request.method !== "POST") {
      return jsonResponse({ error: { code: "method_not_allowed", message: "此端點只接受 POST。" } }, 405, { allow: "POST" });
    }

    const authError = authenticationError(request);
    if (authError) return authError;
    if (rateLimitExceeded(request)) {
      return apiError("rate_limited", "短時間請求過多，請稍候一分鐘再繼續。", 429);
    }

    const contentLength = Number(request.headers.get("content-length") || 0);
    if (contentLength > MAX_BODY_BYTES) return apiError("request_too_large", "請求內容超過後台允許大小。", 413);

    let rawBody;
    try {
      rawBody = await request.text();
    } catch {
      return apiError("invalid_body", "無法讀取請求內容。", 400);
    }
    if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) {
      return apiError("request_too_large", "請求內容超過後台允許大小。", 413);
    }

    let input;
    try {
      input = JSON.parse(rawBody);
    } catch {
      return apiError("invalid_json", "請求內容不是有效的 JSON。", 400);
    }
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return apiError("invalid_request", "請求格式不正確。", 400);
    }

    const role = input.role;
    const provider = input.provider;
    const model = input.model;
    const system = input.system == null ? "" : input.system;
    const user = input.user;
    if (!["A", "B", "C"].includes(role)) return apiError("invalid_role", "角色必須是 A、B 或 C。", 400);
    if (!["openai", "gemini"].includes(provider)) return apiError("invalid_provider", "不支援的供應商。", 400);
    if (typeof model !== "string" || !modelAllowedForRole(provider, model, role)) {
      return apiError("model_not_allowed", "此角色不可使用該模型；請重新整理後端模型清單。", 400);
    }
    if (typeof system !== "string" || typeof user !== "string" || !user.trim()) {
      return apiError("invalid_prompt", "system 與 user 必須是文字，且 user 不可空白。", 400);
    }
    if (system.length > MAX_SYSTEM_CHARS || user.length > MAX_USER_CHARS) {
      return apiError("prompt_too_large", "提示文字超過後台允許長度。", 413);
    }

    const apiKey = provider === "openai" ? process.env.OPENAI_API_KEY : process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return apiError("provider_not_configured", "Vercel 尚未設定 " + (provider === "openai" ? "OPENAI_API_KEY" : "GEMINI_API_KEY") + "。", 503);
    }

    try {
      const result = provider === "openai"
        ? await callOpenAI(model, system, user, role, apiKey)
        : await callGemini(model, system, user, role, apiKey);
      if (result.error) return result.error;
      return jsonResponse({
        provider,
        model,
        text: result.data.text,
        finishReason: result.data.finishReason,
        inTok: result.data.inTok,
        outTok: result.data.outTok,
        maxOutputTokens: OUTPUT_TOKEN_LIMITS[role]
      });
    } catch (error) {
      const timedOut = error && (error.name === "TimeoutError" || error.name === "AbortError");
      return apiError(
        timedOut ? "provider_timeout" : "provider_network_error",
        timedOut ? "供應商回應逾時；請稍後重試。" : "無法連線到供應商服務，請稍後重試。",
        timedOut ? 504 : 502
      );
    }
  }
};
