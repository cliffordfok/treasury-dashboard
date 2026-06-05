const DEEPSEEK_API_URL = "https://api.deepseek.com/chat/completions";
const YAHOO_QUOTE_URL = "https://query1.finance.yahoo.com/v7/finance/quote";
const DEFAULT_MODEL = "deepseek-v4-pro";
const STOCK_QUOTE_PROVIDER = "yahoo_finance_unofficial";
const STOCK_QUOTE_TYPE = "delayed_or_regular_market";
const STOCK_SYMBOL_PATTERN = /^[A-Z0-9.-]+$/;
const MAX_STOCK_SYMBOLS = 25;

const jsonResponse = (body, status = 200, corsHeaders = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders,
    },
  });

const buildCorsHeaders = (request, env) => {
  const allowedOrigins = String(env.ALLOWED_ORIGIN || "*")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  const requestOrigin = request.headers.get("Origin") || "";
  const allowAll = allowedOrigins.includes("*");
  const allowOrigin = allowAll
    ? requestOrigin || "*"
    : allowedOrigins.includes(requestOrigin)
      ? requestOrigin
      : allowedOrigins[0] || "";

  return {
    "Access-Control-Allow-Origin": allowOrigin,
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

const normalizeStockSymbols = (symbols = []) => {
  if (!Array.isArray(symbols)) throw new Error("symbols must be an array");
  const normalized = [...new Set(symbols.map((symbol) => String(symbol || "").trim().toUpperCase()).filter(Boolean))];
  if (normalized.length === 0) throw new Error("At least one symbol is required");
  if (normalized.length > MAX_STOCK_SYMBOLS) throw new Error(`Maximum ${MAX_STOCK_SYMBOLS} symbols per request`);
  const invalid = normalized.find((symbol) => !STOCK_SYMBOL_PATTERN.test(symbol));
  if (invalid) throw new Error(`Invalid symbol: ${invalid}`);
  return normalized;
};

const toIsoDate = (value) => {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value > 100000000000 ? value : value * 1000;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? "" : date.toISOString();
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
};

const toNumberOrNull = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const parseYahooQuoteResponse = (payload = {}, requestedSymbols = []) => {
  const rows = Array.isArray(payload?.quoteResponse?.result) ? payload.quoteResponse.result : [];
  const requested = requestedSymbols.map((symbol) => String(symbol || "").trim().toUpperCase()).filter(Boolean);
  const quotes = [];
  const errors = [];
  const seen = new Set();

  rows.forEach((row) => {
    const symbol = String(row?.symbol || "").trim().toUpperCase();
    if (!symbol) return;
    seen.add(symbol);
    const price = toNumberOrNull(row.regularMarketPrice);
    if (!price || price <= 0) {
      errors.push({ symbol, error: "No quote returned" });
      return;
    }
    quotes.push({
      symbol,
      price,
      currency: String(row.currency || "USD").trim().toUpperCase() || "USD",
      asOf: toIsoDate(row.regularMarketTime) || new Date().toISOString(),
      previousClose: toNumberOrNull(row.regularMarketPreviousClose),
      change: toNumberOrNull(row.regularMarketChange),
      changePercent: toNumberOrNull(row.regularMarketChangePercent),
      source: STOCK_QUOTE_PROVIDER,
      quoteType: STOCK_QUOTE_TYPE,
    });
  });

  requested.forEach((symbol) => {
    if (!seen.has(symbol)) errors.push({ symbol, error: "No quote returned" });
  });

  return {
    provider: STOCK_QUOTE_PROVIDER,
    quoteType: STOCK_QUOTE_TYPE,
    quotes,
    errors,
  };
};

const fetchStockQuotes = async (symbols) => {
  const normalizedSymbols = normalizeStockSymbols(symbols);
  const upstream = await fetch(`${YAHOO_QUOTE_URL}?symbols=${encodeURIComponent(normalizedSymbols.join(","))}`, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "Mozilla/5.0 treasury-dashboard-stock-quote-proxy",
    },
  });
  if (!upstream.ok) {
    return {
      provider: STOCK_QUOTE_PROVIDER,
      quoteType: STOCK_QUOTE_TYPE,
      quotes: [],
      errors: normalizedSymbols.map((symbol) => ({ symbol, error: `Yahoo Finance HTTP ${upstream.status}` })),
    };
  }
  return parseYahooQuoteResponse(await upstream.json(), normalizedSymbols);
};

const callDeepSeek = async ({ apiKey, env, messages, model, temperature = 0.2, responseFormat }) => {
  const deepSeekApiKey = String(apiKey || env.DEEPSEEK_API_KEY || "").trim();
  if (!deepSeekApiKey) {
    throw new Error("DEEPSEEK_API_KEY is not configured");
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
  "type": "t-bill" | "t-note" | "t-bond" | "tips",
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

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method !== "POST") {
      return jsonResponse({ error: "Method not allowed" }, 405, corsHeaders);
    }

    try {
      const body = await request.json();
      const userApiKey = request.headers.get("X-DeepSeek-API-Key") || "";

      if (Array.isArray(body.symbols) || body.task === "fetchStockQuotes") {
        return jsonResponse(await fetchStockQuotes(body.symbols), 200, corsHeaders);
      }

      if (body.task === "generateText") {
        const text = await callDeepSeek({
          apiKey: userApiKey,
          env,
          model: body.model,
          messages: [
            { role: "system", content: "You are a concise fixed-income portfolio analyst." },
            { role: "user", content: String(body.prompt || "") },
          ],
          temperature: 0.3,
        });
        return jsonResponse({ text }, 200, corsHeaders);
      }

      if (body.task === "extractTradeData") {
        const text = await callDeepSeek({
          apiKey: userApiKey,
          env,
          messages: [
            { role: "system", content: "Extract structured Treasury trade data. Return JSON only." },
            { role: "user", content: buildTradeExtractionPrompt(String(body.rawText || "")) },
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
