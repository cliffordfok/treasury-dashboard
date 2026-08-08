const DEEPSEEK_API_URL = "https://api.deepseek.com/chat/completions";
const DEFAULT_MODEL = "deepseek-v4-pro";

const jsonResponse = (body, status = 200, corsHeaders = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders,
    },
  });

const getAllowedOrigins = (env) => String(env.ALLOWED_ORIGIN || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const isOriginAllowed = (request, env) => {
  const requestOrigin = request.headers.get("Origin");
  if (!requestOrigin) return true;
  const allowedOrigins = getAllowedOrigins(env);
  return allowedOrigins.includes("*") || allowedOrigins.includes(requestOrigin);
};

const buildCorsHeaders = (request, env) => {
  const allowedOrigins = getAllowedOrigins(env);
  const requestOrigin = request.headers.get("Origin") || "";
  const allowAll = allowedOrigins.includes("*");
  const allowOrigin = allowAll
    ? requestOrigin || "*"
    : allowedOrigins.includes(requestOrigin)
      ? requestOrigin
      : "";

  return {
    ...(allowOrigin ? { "Access-Control-Allow-Origin": allowOrigin } : {}),
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-DeepSeek-API-Key",
    "Vary": "Origin",
  };
};

const stripCodeFence = (text) =>
  String(text || "")
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();

const parseJsonObject = (text) => {
  const cleaned = stripCodeFence(text);
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("AI response did not contain JSON");
    return JSON.parse(match[0]);
  }
};

const callDeepSeek = async ({ apiKey, env, messages, model, temperature = 0.2, responseFormat }) => {
  const deepSeekApiKey = String(apiKey || "").trim();
  if (!deepSeekApiKey) {
    throw new Error("A user-provided DeepSeek API key is required");
  }

  const payload = {
    model: env.DEEPSEEK_MODEL || model || DEFAULT_MODEL,
    messages,
    temperature,
  };

  if (responseFormat) {
    payload.response_format = responseFormat;
  }

  const upstream = await fetch(DEEPSEEK_API_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${deepSeekApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await upstream.json().catch(() => ({}));
  if (!upstream.ok) {
    const message = data?.error?.message || `DeepSeek returned HTTP ${upstream.status}`;
    throw new Error(message);
  }

  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error("DeepSeek response was empty");
  return text;
};

const buildTradeExtractionPrompt = (rawText) => `Extract one US Treasury trade from the text.

Return only valid JSON with these fields:
{
  "cusip": string,
  "type": "t-bill" | "t-note" | "t-bond",
  "side": "buy" | "sell",
  "tradeDate": "YYYY-MM-DD",
  "maturityDate": "YYYY-MM-DD",
  "faceValue": number,
  "cleanPrice": number,
  "couponRate": number,
  "couponFrequency": number,
  "commission": number,
  "accruedInterestPer100": number | ""
}

Rules:
- Use "buy" unless the text clearly says sell/short.
- Use clean price, not dirty price, when both are present.
- T-Bill couponRate must be 0 and couponFrequency must be 0.
- For T-Note/T-Bond, default couponFrequency to 2 when not stated.
- Use an empty string for unknown optional accruedInterestPer100.
- Do not include markdown or explanatory text.

Trade text:
${rawText}`;

export default {
  async fetch(request, env) {
    const corsHeaders = buildCorsHeaders(request, env);

    if (!isOriginAllowed(request, env)) {
      return jsonResponse({ error: "Origin not allowed" }, 403, corsHeaders);
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method !== "POST") {
      return jsonResponse({ error: "Method not allowed" }, 405, corsHeaders);
    }

    const userApiKey = request.headers.get("X-DeepSeek-API-Key") || "";
    if (!userApiKey.trim()) {
      return jsonResponse({ error: "DeepSeek API key is required" }, 401, corsHeaders);
    }

    const contentLength = Number(request.headers.get("Content-Length") || 0);
    if (Number.isFinite(contentLength) && contentLength > 50000) {
      return jsonResponse({ error: "Request body is too large" }, 413, corsHeaders);
    }

    let rawBody;
    try {
      rawBody = await request.text();
    } catch {
      return jsonResponse({ error: "Unable to read request body" }, 400, corsHeaders);
    }
    if (rawBody.length > 50000) {
      return jsonResponse({ error: "Request body is too large" }, 413, corsHeaders);
    }

    let body;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return jsonResponse({ error: "Request body must be valid JSON" }, 400, corsHeaders);
    }

    try {
      if (body.task === "extractTradeData") {
        const rawText = String(body.rawText || "").trim();
        if (!rawText || rawText.length > 20000) {
          return jsonResponse({ error: "rawText must contain between 1 and 20000 characters" }, 400, corsHeaders);
        }
        const text = await callDeepSeek({
          apiKey: userApiKey,
          env,
          messages: [
            { role: "system", content: "Extract structured Treasury trade data. Return JSON only." },
            { role: "user", content: buildTradeExtractionPrompt(rawText) },
          ],
          temperature: 0,
          responseFormat: { type: "json_object" },
        });
        return jsonResponse({ trade: parseJsonObject(text) }, 200, corsHeaders);
      }

      return jsonResponse({ error: "Unknown task" }, 400, corsHeaders);
    } catch (error) {
      return jsonResponse({ error: error.message || "AI proxy failed" }, 500, corsHeaders);
    }
  },
};
