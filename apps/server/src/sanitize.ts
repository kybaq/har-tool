import type { RequestLog } from "@pkg/shared";

const DEFAULT_MASK = "***redacted***";

// 헤더에서 무조건 가려야 할 것들(대소문자 무시)
const SENSITIVE_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "x-csrf-token",
  "x-xsrf-token",
  "x-amz-security-token",
]);

// 쿼리 파라미터에서 자주 쓰는 민감 키
const SENSITIVE_QUERY_KEYS = [
  "token",
  "access_token",
  "refresh_token",
  "id_token",
  "api_key",
  "apikey",
  "key",
  "code",
  "password",
  "passwd",
  "secret",
  "signature",
  "sig",
];

// JSON 바디에서 자주 쓰는 민감 키(부분 매칭)
const SENSITIVE_JSON_KEY_PATTERNS = [
  "password",
  "passwd",
  "secret",
  "token",
  "refresh",
  "access",
  "authorization",
  "cookie",
  "apikey",
  "api_key",
  "session",
  "csrf",
  "xsrf",
];

function redactValue(_v: unknown) {
  return DEFAULT_MASK;
}

function maskHeaders(headers?: Record<string, string>) {
  if (!headers) return headers;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const key = k.toLowerCase();
    out[k] = SENSITIVE_HEADERS.has(key) ? DEFAULT_MASK : v;
  }
  return out;
}

function maskQuery(query?: Record<string, string>) {
  if (!query) return query;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(query)) {
    const key = k.toLowerCase();
    const hit = SENSITIVE_QUERY_KEYS.some(
      (s) => key === s || key.endsWith(`_${s}`) || key.includes(s)
    );
    out[k] = hit ? DEFAULT_MASK : v;
  }
  return out;
}

// JSON 문자열이면 파싱해서 key 기반 마스킹 후 다시 stringify
function maskJsonText(text: string) {
  try {
    const data = JSON.parse(text);
    const masked = deepMaskJson(data);
    return JSON.stringify(masked, null, 2);
  } catch {
    return text;
  }
}

function shouldMaskJsonKey(key: string) {
  const k = key.toLowerCase();
  return SENSITIVE_JSON_KEY_PATTERNS.some((p) => k === p || k.includes(p));
}

function deepMaskJson(value: any): any {
  if (Array.isArray(value)) return value.map(deepMaskJson);
  if (value && typeof value === "object") {
    const out: any = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = shouldMaskJsonKey(k) ? redactValue(v) : deepMaskJson(v);
    }
    return out;
  }
  return value;
}

function maskBody(body?: { mime?: string; text?: string }) {
  if (!body) return body;
  const mime = (body.mime || "").toLowerCase();
  const text = body.text || "";

  // 폼데이터/URL-encoded도 키 기반 간단 마스킹
  if (mime.includes("application/x-www-form-urlencoded")) {
    const params = new URLSearchParams(text);
    for (const key of params.keys()) {
      const k = key.toLowerCase();
      const hit = SENSITIVE_QUERY_KEYS.some((s) => k === s || k.includes(s));
      if (hit) params.set(key, DEFAULT_MASK);
    }
    return { ...body, text: params.toString() };
  }

  // JSON
  if (
    mime.includes("application/json") ||
    text.trim().startsWith("{") ||
    text.trim().startsWith("[")
  ) {
    return { ...body, text: maskJsonText(text) };
  }

  // 그 외는 그대로(필요하면 여기서 더 확장)
  return body;
}

export function sanitizeLog(log: RequestLog): RequestLog {
  return {
    ...log,
    request: {
      ...log.request,
      headers: maskHeaders(log.request.headers),
      query: maskQuery(log.request.query),
      body: maskBody(log.request.body),
    },
    response: log.response
      ? {
          ...log.response,
          headers: maskHeaders(log.response.headers),
          body: maskBody(log.response.body),
        }
      : log.response,
  };
}
