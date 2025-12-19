import { reportToMarkdown } from "./markdown";

function details(summary: string, body: string, open = false) {
  const lines: string[] = [];
  lines.push(open ? `<details open>` : `<details>`);
  lines.push(`<summary>${summary}</summary>`);
  lines.push("");
  lines.push(body);
  lines.push("");
  lines.push(`</details>`);
  return lines.join("\n");
}

export function catalogToMarkdown(catalog: { createdAt: number; routeReports: any[] }) {
  const lines: string[] = [];
  lines.push(`# Route Catalog`);
  lines.push(`- Generated: ${new Date(catalog.createdAt).toLocaleString()}`);
  lines.push("");

  for (const r of catalog.routeReports) {
    const body = reportToMarkdown(r);
    const summary =
      `Route: \`${r.routeKey}\` · Hosts: ${new Set((r.endpoints ?? []).map((e: any) => e.host)).size}` +
      ` · Endpoints: ${r.endpoints?.length ?? 0}` +
      ` · Logs: ${r.totalLogs ?? 0}`;

    lines.push(details(summary, body, false)); // 기본 닫힘
    lines.push("");
  }

  return lines.join("\n");
}
