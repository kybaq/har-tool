import type { RouteReport } from "./routeReport";
import { buildRouteReport } from "./routeReport";
import type { RequestLog } from "@pkg/shared";

type SessionMetaLite = { id: string; name: string; routeKey?: string };

export async function buildRouteCatalog(args: {
  listSessions: () => Promise<SessionMetaLite[]>;
  readReport: (sessionId: string) => Promise<RouteReport | null>;
  writeReport: (sessionId: string, report: RouteReport) => Promise<void>;
  readLogs: (sessionId: string, limit: number) => Promise<RequestLog[]>;
}) {
  const sessions = await args.listSessions();

  // routeKey -> reports[]
  const byRoute = new Map<string, RouteReport[]>();

  for (const s of sessions) {
    const routeKey = (s.routeKey || s.name || "/").trim() || "/";
    let report = await args.readReport(s.id);

    // report 캐시가 없으면 1회 생성 후 저장
    if (!report) {
      const logs = await args.readLogs(s.id, 200000);
      report = buildRouteReport({ routeKey, sessionId: s.id, logs });
      await args.writeReport(s.id, report);
    }

    const arr = byRoute.get(routeKey) ?? [];
    arr.push(report);
    byRoute.set(routeKey, arr);
  }

  // routeKey별로 엔드포인트 합치기(Union + count/status 합산)
  const routeReports: RouteReport[] = [];

  for (const [routeKey, reports] of byRoute.entries()) {
    const merged = mergeReports(routeKey, reports);
    routeReports.push(merged);
  }

  routeReports.sort((a, b) => a.routeKey.localeCompare(b.routeKey));
  return { createdAt: Date.now(), routeReports };
}

function mergeReports(routeKey: string, reports: RouteReport[]): RouteReport {
  const map = new Map<string, any>();

  let totalLogs = 0;

  for (const r of reports) {
    totalLogs += Number(r.totalLogs ?? 0);
    for (const e of r.endpoints ?? []) {
      const prev = map.get(e.key);
      if (!prev) {
        map.set(e.key, {
          ...e,
          // sample은 “첫 번째 것” 유지(또는 count 큰 쪽 선택해도 됨)
          sample: e.sample,
        });
      } else {
        prev.count += e.count;
        prev.statuses = mergeCountMap(prev.statuses, e.statuses);
        prev.mime = {
          req: mergeCountMap(prev.mime?.req ?? {}, e.mime?.req ?? {}),
          res: mergeCountMap(prev.mime?.res ?? {}, e.mime?.res ?? {}),
        };
        prev.queryKeys = Array.from(new Set([...(prev.queryKeys ?? []), ...(e.queryKeys ?? [])])).sort();
      }
    }
  }

  const endpoints = Array.from(map.values()).sort((a, b) => b.count - a.count);

  return {
    routeKey,
    sessionId: `${routeKey} (${reports.length} sessions)`,
    createdAt: Date.now(),
    totalLogs,
    endpoints,
  } as any;
}

function mergeCountMap(a: Record<string, number> = {}, b: Record<string, number> = {}) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = (out[k] ?? 0) + Number(v ?? 0);
  return out;
}
