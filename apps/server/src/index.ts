import express from "express";
import cors from "cors";
import { nanoid } from "nanoid";
import type { RequestLog } from "@pkg/shared";
// import { startForwardProxy } from "./proxy";
import { startMitmProxy } from "./mitmProxy";
import { sanitizeLog } from "./sanitize";
import { SessionStore } from "./sessionStore";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// ===== in-memory store (MVP) =====
const logs: RequestLog[] = [];
const MAX_LOGS = 2000;

const sessionStore = new SessionStore();
await sessionStore.init(); // top-level await 가능하면(ESM) 여기서

// ===== SSE clients =====
type SseClient = { id: string; res: express.Response };
const clients = new Map<string, SseClient>();

async function pushLog(log: RequestLog) {
  const safe = sanitizeLog(log);

  logs.unshift(safe);
  if (logs.length > MAX_LOGS) logs.length = MAX_LOGS;

  // 세션 저장(비동기, 실패해도 UI는 계속)
  sessionStore
    .append(safe)
    .catch((e) => console.error("[session] append failed", e));

  const payload = `event: log\ndata: ${JSON.stringify(safe)}\n\n`;
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
        accept: "application/json",
      },
      query: Object.fromEntries(u.searchParams.entries()),
    },
    response: {
      headers: { "content-type": "application/json" },
      body: {
        mime: "application/json",
        text: JSON.stringify({ ok: true }, null, 2),
      },
    },
  };

  pushLog(log);
  res.json({ ok: true, id: log.id });
});

app.get("/api/sessions", async (_req, res) => {
  const items = await sessionStore.list();
  res.json({ items, current: sessionStore.getCurrent() });
});

app.get("/api/sessions/:id", async (req, res) => {
  const meta = await sessionStore.read(req.params.id);
  if (!meta) return res.status(404).json({ error: "not found" });
  res.json(meta);
});

app.get("/api/sessions/:id/logs", async (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 500), 5000);
  const items = await sessionStore.readLogs(req.params.id, limit);
  res.json({ items });
});

app.post("/api/sessions/start", async (req, res) => {
  const name = typeof req.body?.name === "string" ? req.body.name : undefined;
  const meta = await sessionStore.start(name);
  res.json(meta);
});

app.post("/api/sessions/stop", async (_req, res) => {
  const meta = await sessionStore.stop();
  res.json(meta ?? { ok: true, message: "no active session" });
});

// 세션 정보 다운로드
app.get("/api/sessions/:id/export", async (req, res) => {
  const id = req.params.id;
  const format = String(req.query.format ?? "json"); // json | har

  const meta = await sessionStore.read(id);
  if (!meta) {
    res.status(404).json({ error: "session not found" });
    return;
  }

  // NOTE: MVP: 메모리로 읽기(대용량이면 스트리밍으로 개선 가능)
  const items = await sessionStore.readLogs(id, 200000);

  if (format === "json") {
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader(
      "content-disposition",
      `attachment; filename="session-${id}.json"`
    );
    res.end(JSON.stringify({ session: meta, items }, null, 2));
    return;
  }

  if (format === "har") {
    const har = toHar(items);
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader(
      "content-disposition",
      `attachment; filename="session-${id}.har"`
    );
    res.end(JSON.stringify(har, null, 2));
    return;
  }

  res.status(400).json({ error: "invalid format" });
});

// --- HAR 변환 (MVP)
function toHar(items: RequestLog[]) {
  const entries = items.map((l) => {
    const startedDateTime = new Date(l.ts).toISOString();
    const time = Number(l.durationMs ?? 0);

    const reqHeaders = Object.entries(l.request?.headers ?? {}).map(
      ([name, value]) => ({ name, value })
    );
    const qs = Object.entries(l.request?.query ?? {}).map(([name, value]) => ({
      name,
      value,
    }));

    const postText = l.request?.body?.text ?? "";
    const postMime = l.request?.body?.mime ?? "text/plain";

    const resHeaders = Object.entries(l.response?.headers ?? {}).map(
      ([name, value]) => ({ name, value })
    );

    const resText = l.response?.body?.text ?? "";
    const resMime = l.response?.body?.mime ?? "";

    return {
      startedDateTime,
      time,
      request: {
        method: l.method,
        url: l.url,
        httpVersion: "HTTP/1.1",
        headers: reqHeaders,
        queryString: qs,
        ...(postText
          ? { postData: { mimeType: postMime, text: postText } }
          : {}),
      },
      response: {
        status: Number(l.status ?? 0),
        statusText: "",
        httpVersion: "HTTP/1.1",
        headers: resHeaders,
        content: {
          mimeType: resMime,
          text: resText,
        },
        redirectURL: "",
        headersSize: -1,
        bodySize: -1,
      },
      cache: {},
      timings: {
        send: 0,
        wait: time,
        receive: 0,
      },
    };
  });

  return {
    log: {
      version: "1.2",
      creator: { name: "har-tool", version: "0.0.0" },
      pages: [],
      entries,
    },
  };
}

const PORT = Number(process.env.PORT ?? 8787);
// const PROXY_PORT = Number(process.env.PROXY_PORT ?? 8888);
const MITM_PORT = Number(process.env.MITM_PORT ?? 8888);

app.listen(PORT, () => {
  console.log(`[server] http://localhost:${PORT}`);
  // startForwardProxy(PROXY_PORT, pushLog);
  startMitmProxy({ port: MITM_PORT, pushLog });
});
