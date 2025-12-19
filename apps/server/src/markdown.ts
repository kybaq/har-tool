import type { RouteReport } from "./routeReport";

function mdEscape(s: string) {
  return String(s ?? "").replace(/\|/g, "\\|");
}

function mdCode(s: string) {
  return "`" + String(s ?? "").replace(/`/g, "\\`") + "`";
}

function details(summary: string, bodyLines: string[], open = false) {
  const lines: string[] = [];
  lines.push(open ? `<details open>` : `<details>`);
  lines.push(`<summary>${summary}</summary>`);
  lines.push("");
  lines.push(...bodyLines);
  lines.push("");
  lines.push(`</details>`);
  return lines;
}

export function reportToMarkdown(report: RouteReport) {
  const lines: string[] = [];

  lines.push(`# Route API Map`);
  lines.push("");
  lines.push(`- **Route**: ${mdCode(report.routeKey)}`);
  lines.push(`- **Session**: ${mdCode(report.sessionId)}`);
  lines.push(`- **Captured**: ${new Date(report.createdAt).toLocaleString()}`);
  lines.push(`- **Total Logs**: ${report.totalLogs}`);
  lines.push("");

  // ✅ Host별 그룹
  const byHost = new Map<string, typeof report.endpoints>();
  for (const e of report.endpoints) {
    const arr = byHost.get(e.host) ?? [];
    arr.push(e);
    byHost.set(e.host, arr);
  }

  for (const [host, eps] of Array.from(byHost.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
    const hostLines: string[] = [];
    
    hostLines.push(`## Host: ${mdCode(host)}`);
    hostLines.push("");

    hostLines.push(`| Method | Path | Count | Statuses | Query Keys |`);
    hostLines.push(`| --- | --- | ---: | --- | --- |`);

  for (const e of eps.sort((a, b) => b.count - a.count)) {
    const statuses = Object.entries(e.statuses ?? {})
      .sort((a, b) => Number(b[1]) - Number(a[1]))
      .slice(0, 6)
      .map(([k, v]) => `${k}:${v}`)
      .join(" ");

    const qk = (e.queryKeys ?? []).slice(0, 10).join(", ");
    hostLines.push(
      `| ${mdCode(e.method)} | ${mdCode(mdEscape(e.path))} | ${e.count} | ${mdEscape(statuses)} | ${qk ? mdCode(qk) : ""} |`
    );
  }

  hostLines.push("");

    // ✅ 샘플 섹션(엔드포인트별 1개)
    hostLines.push(`### Samples`);
    hostLines.push("");

    for (const e of eps.sort((a, b) => b.count - a.count)) {
      if (!e.sample) continue;

      hostLines.push(`#### ${mdCode(e.method)} ${mdCode(e.path)}`);
      hostLines.push("");
      hostLines.push(`- URL: ${mdCode(e.sample.url)}`);
      hostLines.push(`- Status: ${mdCode(String(e.sample.status ?? ""))}`);
      hostLines.push("");

      hostLines.push(`**Request headers (partial)**`);
      hostLines.push("```json");
      hostLines.push(JSON.stringify(e.sample.request.headers ?? {}, null, 2));
      hostLines.push("```");
      hostLines.push("");

      hostLines.push(`**Request body (partial)**`);
      hostLines.push("```");
      hostLines.push(e.sample.request.body?.text ?? "");
      hostLines.push("```");
      hostLines.push("");

      hostLines.push(`**Response headers (partial)**`);
      hostLines.push("```json");
      hostLines.push(JSON.stringify(e.sample.response?.headers ?? {}, null, 2));
      hostLines.push("```");
      hostLines.push("");

      hostLines.push(`**Response body (partial)**`);
      hostLines.push("```");
      hostLines.push(e.sample.response?.body?.text ?? "");
      hostLines.push("```");
      hostLines.push("");
    }
    // ✅ Host 토글로 감싸기 (기본 닫힘)
    lines.push(...details(`Host: ${mdCode(host)} · Endpoints: ${eps.length}`, hostLines, false));
    lines.push("");
  }

  lines.push(`---`);
  lines.push(`Notes: Paths are normalized (:id/:uuid/:hash). Query values are not stored.`);

  return lines.join("\n");
}
