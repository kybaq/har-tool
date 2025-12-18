import express from "express";
import cors from "cors";
import { nanoid } from "nanoid";
import type { RequestLog } from "@pkg/shared";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// ===== in-memory store (MVP) =====
const logs: RequestLog[] = [];
const MAX_LOGS = 2000;

// ===== SSE clients =====
type SseClient = { id: string; res: express.Response };
const clients = new Map<string, SseClient>();

function pushLog(log: RequestLog) {
  logs.unshift(log);
  if (logs.length > MAX_LOGS) logs.length = MAX_LOGS;

  const payload = `event: log\ndata: ${JSON.stringify(log)}\n\n`;
  for (const c of clients.values()) c.res.write(payload);
}

// ===== endpoints =====
app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");

  // some proxies buffer unless you flush headers
  res.flushHeaders?.();

  const id = nanoid();
  clients.set(id, { id, res });

  // initial hello
  res.write(`event: hello\ndata: ${JSON.stringify({ clientId: id })}\n\n`);

  req.on("close", () => {
    clients.delete(id);
  });
});

app.get("/api/logs", (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 200), 2000);
  res.json({ items: logs.slice(0, limit) });
});

app.post("/api/clear", (_req, res) => {
  logs.length = 0;
  res.json({ ok: true });
});

// mock: generate one fake log
app.post("/api/mock", (_req, res) => {
  const start = Date.now();
  const durationMs = Math.floor(Math.random() * 220) + 20;
  const status = [200, 201, 204, 301, 400, 401, 403, 404, 500][
    Math.floor(Math.random() * 9)
  ];

  const url = "https://api.example.com/v1/users?active=true";
  const u = new URL(url);

  const log: RequestLog = {
    id: nanoid(),
    ts: Date.now(),
    method: "GET",
    url,
    host: u.host,
    path: u.pathname,
    status,
    durationMs: Math.max(1, Date.now() - start + durationMs),
    request: {
      headers: {
        "user-agent": "har-toolkit-clone/0.0.0",
        accept: "application/json"
      },
      query: Object.fromEntries(u.searchParams.entries())
    },
    response: {
      headers: { "content-type": "application/json" },
      body: { mime: "application/json", text: JSON.stringify({ ok: true }, null, 2) }
    }
  };

  pushLog(log);
  res.json({ ok: true, id: log.id });
});

const PORT = Number(process.env.PORT ?? 8787);
app.listen(PORT, () => {
  console.log(`[server] http://localhost:${PORT}`);
});
