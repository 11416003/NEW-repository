import { authenticationError, jsonResponse } from "../lib/security.js";
import { MODEL_CATALOG, JUDGE_MODEL_CATALOG, OUTPUT_TOKEN_LIMITS } from "../lib/model-catalog.js";

export default {
  async fetch(request) {
    if (request.method !== "GET") {
      return jsonResponse({ error: { code: "method_not_allowed", message: "此端點只接受 GET。" } }, 405, { allow: "GET" });
    }
    const authError = authenticationError(request);
    if (authError) return authError;

    return jsonResponse({
      catalog: MODEL_CATALOG,
      judgeCatalog: JUDGE_MODEL_CATALOG,
      outputTokenLimits: OUTPUT_TOKEN_LIMITS
    });
  }
};
