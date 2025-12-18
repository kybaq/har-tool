import { useEffect, useMemo, useReducer, useState } from "react";
import type { RequestLog } from "@pkg/shared";
import type { SessionMeta } from "./types";

type State = {
  items: RequestLog[];
  connected: boolean;
};

type Action =
  | { type: "connected"; value: boolean }
  | { type: "prepend"; log: RequestLog }
  | { type: "set"; items: RequestLog[] }
  | { type: "clear" };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "connected":
      return { ...state, connected: action.value };
    case "prepend":
      return { ...state, items: [action.log, ...state.items].slice(0, 2000) };
    case "set":
      return { ...state, items: action.items };
    case "clear":
      return { ...state, items: [] };
    default:
      return state;
  }
}

export default function App() {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [currentSession, setCurrentSession] = useState<SessionMeta | null>(
    null
  );
  const [selectedSessionId, setSelectedSessionId] = useState<string>("");
  const [sessionName, setSessionName] = useState("");

  const [state, dispatch] = useReducer(reducer, {
    items: [],
    connected: false,
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [q, setQ] = useState("");

  const selected = useMemo(
    () => state.items.find((x) => x.id === selectedId) ?? null,
    [state.items, selectedId]
  );

  async function refreshSessions() {
    const r = await fetch("/api/sessions");
    const d = await r.json();
    setSessions(d.items ?? []);
    setCurrentSession(d.current ?? null);
  }

  async function startSession() {
    const r = await fetch("/api/sessions/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: sessionName || undefined }),
    });
    if (r.ok) {
      setSessionName("");
      await refreshSessions();
    }
  }

  async function stopSession() {
    await fetch("/api/sessions/stop", { method: "POST" });
    await refreshSessions();
  }

  async function loadSessionLogs(sessionId: string) {
    const r = await fetch(`/api/sessions/${sessionId}/logs?limit=2000`);
    const d = await r.json();
    dispatch({ type: "set", items: d.items ?? [] });
    setSelectedId(null);
  }

  function downloadSession(format: "json" | "har") {
    if (!selectedSessionId) return;
    // 다운로드 트리거
    window.location.href = `/api/sessions/${selectedSessionId}/export?format=${format}`;
  }

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      try {
        const [sessionsRes, logsRes] = await Promise.all([
          fetch("/api/sessions"),
          fetch("/api/logs?limit=200"),
        ]);

        const sessionsData = await sessionsRes.json();
        const logsData = await logsRes.json();

        if (cancelled) return;

        setSessions(sessionsData.items ?? []);
        setCurrentSession(sessionsData.current ?? null);

        dispatch({ type: "set", items: logsData.items ?? [] });
      } catch (e) {
        console.error(e);
      }
    }

    bootstrap();

    const es = new EventSource("/events");

    es.addEventListener("open", () =>
      dispatch({ type: "connected", value: true })
    );
    es.addEventListener("error", () =>
      dispatch({ type: "connected", value: false })
    );

    es.addEventListener("log", (e) => {
      const log = JSON.parse((e as MessageEvent).data) as RequestLog;
      dispatch({ type: "prepend", log });
    });

    return () => {
      cancelled = true;
      es.close();
    };
  }, []);

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return state.items;
    return state.items.filter((x) => {
      return (
        x.url.toLowerCase().includes(term) ||
        x.method.toLowerCase().includes(term) ||
        String(x.status ?? "").includes(term)
      );
    });
  }, [state.items, q]);

  async function onMock() {
    await fetch("/api/mock", { method: "POST" });
  }
  async function onClear() {
    await fetch("/api/clear", { method: "POST" });
    dispatch({ type: "clear" });
    setSelectedId(null);
  }

  return (
    <div
      style={{ height: "100vh", display: "grid", gridTemplateRows: "56px 1fr" }}
    >
      <header
        style={{
          display: "flex",
          gap: 12,
          alignItems: "center",
          padding: "0 16px",
          borderBottom: "1px solid #eee",
        }}
      >
        <strong>Local HTTP Capture (MVP)</strong>
        <span style={{ fontSize: 12, opacity: 0.7 }}>
          {state.connected ? "● connected" : "○ disconnected"}
        </span>
        <div style={{ flex: 1 }} />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="filter: url / method / status"
          style={{ width: 360, padding: "8px 10px" }}
        />

        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ fontSize: 12, opacity: 0.7 }}>
            Session:{" "}
            {currentSession
              ? `${currentSession.name} (${currentSession.logCount})`
              : "none"}
          </span>

          <input
            value={sessionName}
            onChange={(e) => setSessionName(e.target.value)}
            placeholder="session name"
            style={{ width: 200, padding: "8px 10px" }}
          />

          <button onClick={startSession} disabled={Boolean(currentSession)}>
            start
          </button>
          <button onClick={stopSession} disabled={!currentSession}>
            stop
          </button>

          <select
            value={selectedSessionId}
            onChange={async (e) => {
              const id = e.target.value;
              setSelectedSessionId(id);
              if (id) await loadSessionLogs(id);
            }}
            style={{ padding: "8px 10px" }}
          >
            <option value="">Load session…</option>
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {new Date(s.createdAt).toLocaleString()} · {s.name} ·{" "}
                {s.logCount}
              </option>
            ))}
          </select>

          <button
            disabled={!selectedSessionId}
            onClick={() => downloadSession("json")}
          >
            export json
          </button>

          <button
            disabled={!selectedSessionId}
            onClick={() => downloadSession("har")}
          >
            export har
          </button>
        </div>

        <button onClick={onMock}>+ mock</button>
        <button onClick={onClear}>clear</button>
      </header>

      <main
        style={{
          display: "grid",
          gridTemplateColumns: "420px 1fr",
          minHeight: 0,
        }}
      >
        {/* List */}
        <section style={{ borderRight: "1px solid #eee", overflow: "auto" }}>
          {filtered.map((x) => {
            const active = x.id === selectedId;
            return (
              <button
                key={x.id}
                onClick={() => setSelectedId(x.id)}
                style={{
                  width: "100%",
                  textAlign: "left",
                  border: "none",
                  borderBottom: "1px solid #f2f2f2",
                  background: active ? "#f7f7f7" : "white",
                  padding: "10px 12px",
                  cursor: "pointer",
                }}
              >
                <div
                  style={{ display: "flex", gap: 8, alignItems: "baseline" }}
                >
                  <span style={{ width: 56, fontWeight: 700 }}>{x.method}</span>
                  <span style={{ width: 52, opacity: 0.8 }}>
                    {x.status ?? "-"}
                  </span>
                  <span
                    style={{
                      flex: 1,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {x.host}
                    {x.path}
                  </span>
                </div>
                <div style={{ marginTop: 4, fontSize: 12, opacity: 0.7 }}>
                  {new Date(x.ts).toLocaleTimeString()} · {x.durationMs ?? "-"}{" "}
                  ms
                </div>
              </button>
            );
          })}
        </section>

        {/* Details */}
        <section style={{ overflow: "auto", padding: 16 }}>
          {!selected ? (
            <div style={{ opacity: 0.7 }}>왼쪽에서 요청을 선택해줘.</div>
          ) : (
            <div style={{ display: "grid", gap: 12 }}>
              <div>
                <div style={{ fontSize: 12, opacity: 0.7 }}>URL</div>
                <div style={{ wordBreak: "break-all" }}>{selected.url}</div>
              </div>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: 12,
                }}
              >
                <KV title="Request Headers" obj={selected.request.headers} />
                <KV
                  title="Response Headers"
                  obj={selected.response?.headers ?? {}}
                />
              </div>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: 12,
                }}
              >
                <JSONBlock title="Query" value={selected.request.query ?? {}} />
                <JSONBlock
                  title="Timing"
                  value={{
                    status: selected.status,
                    durationMs: selected.durationMs,
                  }}
                />
              </div>

              <JSONBlock
                title="Request Body"
                value={selected.request.body ?? {}}
              />
              <JSONBlock
                title="Response Body"
                value={selected.response?.body ?? {}}
              />
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

function KV({ title, obj }: { title: string; obj: Record<string, string> }) {
  const entries = Object.entries(obj ?? {});
  return (
    <div>
      <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 6 }}>{title}</div>
      <div style={{ border: "1px solid #eee", borderRadius: 8, padding: 10 }}>
        {entries.length === 0 ? (
          <div style={{ opacity: 0.6, fontSize: 12 }}>empty</div>
        ) : (
          entries.map(([k, v]) => (
            <div
              key={k}
              style={{
                display: "grid",
                gridTemplateColumns: "160px 1fr",
                gap: 10,
                padding: "4px 0",
              }}
            >
              <div
                style={{
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                  fontSize: 12,
                  opacity: 0.8,
                }}
              >
                {k}
              </div>
              <div
                style={{
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                  fontSize: 12,
                  wordBreak: "break-all",
                }}
              >
                {v}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function JSONBlock({ title, value }: { title: string; value: unknown }) {
  return (
    <div>
      <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 6 }}>{title}</div>
      <pre
        style={{
          border: "1px solid #eee",
          borderRadius: 8,
          padding: 10,
          overflow: "auto",
        }}
      >
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}
