import type { RequestLog } from "@pkg/shared";
import { normalizePath, queryKeys } from "./normalize";

export type EndpointSample = {
  url: string;
  ts: number;
  status?: number;
  request: {
    headers: Record<string, string>;
    query?: Record<string, string>;
    body?: { mime?: string; text?: string };
  };
  response?: {
    headers?: Record<string, string>;
    body?: { mime?: string; text?: string };
  };
};

export type EndpointSummary = {
  key: string;
  method: string;
  host: string;
  path: string;
  count: number;
  statuses: Record<string, number>;
  queryKeys: string[];
  mime: { req: Record<string, number>; res: Record<string, number> };

  sample?: EndpointSample; // ✅ 추가
};

export type RouteReport = {
  routeKey: string;
  sessionId: string;
  createdAt: number;
  totalLogs: number;
  endpoints: EndpointSummary[];
};

const MAX_SAMPLE_BODY = 2048;

function trimText(s: string, max = MAX_SAMPLE_BODY) {
  if (!s) return s;
  return s.length > max ? s.slice(0, max) + "\n…(truncated)" : s;
}

function pickHeaders(headers: Record<string, string> | undefined, limit = 30) {
  const entries = Object.entries(headers ?? {});
  entries.sort(([a], [b]) => a.localeCompare(b));
  return Object.fromEntries(entries.slice(0, limit));
}

function bump(map: Record<string, number>, k: string) {
  const key = k || "";
  map[key] = (map[key] ?? 0) + 1;
}

function pickMime(v: unknown) {
  const s = String(v ?? "").toLowerCase();
  return s.split(";")[0].trim();
}

export function buildRouteReport(args: {
  routeKey: string;
  sessionId: string;
  logs: RequestLog[];
}): RouteReport {
  const { routeKey, sessionId, logs } = args;

  const byKey = new Map<string, EndpointSummary>();

  for (const l of logs) {
    // URL 파싱 실패 로그는 스킵
    let u: URL;
    try {
      u = new URL(l.url);
    } catch {
      continue;
    }

    const host = u.host;
    const path = normalizePath(u.pathname);
    const method = String(l.method || "GET").toUpperCase();
    const key = `${method} ${host} ${path}`;

    const status = String(l.status ?? "0");

    const qk = queryKeys(u);
    const reqMime = pickMime(l.request?.body?.mime);
    const resMime = pickMime(l.response?.body?.mime);

    let s = byKey.get(key);
    if (!s) {
      s = {
        key,
        method,
        host,
        path,
        count: 0,
        statuses: {},
        queryKeys: [],
        mime: { req: {}, res: {} },

        sample: {
          url: l.url,
          ts: l.ts,
          status: l.status,
          request: {
            headers: pickHeaders(l.request?.headers),
            query: l.request?.query ?? {},
            body: l.request?.body
              ? { ...l.request.body, text: trimText(l.request.body.text ?? "") }
              : undefined,
          },
          response: l.response
            ? {
                headers: pickHeaders(l.response.headers),
                body: l.response.body
                  ? { ...l.response.body, text: trimText(l.response.body.text ?? "") }
                  : undefined,
              }
            : undefined,
        },
      };

      byKey.set(key, s);
    }

    s.count += 1;
    bump(s.statuses, status);
    bump(s.mime.req, reqMime);
    bump(s.mime.res, resMime);

    // query key union
    const set = new Set([...s.queryKeys, ...qk]);
    s.queryKeys = Array.from(set).sort();
  }

  const endpoints = Array.from(byKey.values()).sort((a, b) => b.count - a.count);

  return {
    routeKey,
    sessionId,
    createdAt: Date.now(),
    totalLogs: logs.length,
    endpoints
  };
}
