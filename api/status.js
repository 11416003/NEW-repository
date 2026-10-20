import { authenticationError, jsonResponse } from "../lib/security.js";
import { OUTPUT_TOKEN_LIMITS } from "../lib/model-catalog.js";

export default {
  async fetch(request) {
    if (request.method !== "GET") {
      return jsonResponse({ error: { code: "method_not_allowed", message: "此端點只接受 GET。" } }, 405, { allow: "GET" });
    }
    const authError = authenticationError(request);
    if (authError) return authError;

    return jsonResponse({
      authenticated: true,
      providers: {
        openai: Boolean(process.env.OPENAI_API_KEY),
        gemini: Boolean(process.env.GEMINI_API_KEY)
      },
      outputTokenLimits: OUTPUT_TOKEN_LIMITS
    });
  }
};
