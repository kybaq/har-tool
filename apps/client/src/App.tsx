import { useEffect, useMemo, useReducer, useState } from "react";
import type { RequestLog } from "@pkg/shared";

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
  const [state, dispatch] = useReducer(reducer, { items: [], connected: false });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [q, setQ] = useState("");

  const selected = useMemo(
    () => state.items.find((x) => x.id === selectedId) ?? null,
    [state.items, selectedId]
  );

  useEffect(() => {
    // initial fetch
    fetch("/api/logs?limit=200")
      .then((r) => r.json())
      .then((d) => dispatch({ type: "set", items: d.items ?? [] }))
      .catch(() => {});

    const es = new EventSource("/events");

    es.addEventListener("open", () => dispatch({ type: "connected", value: true }));
    es.addEventListener("error", () => dispatch({ type: "connected", value: false }));

    es.addEventListener("log", (e) => {
      const log = JSON.parse((e as MessageEvent).data) as RequestLog;
      dispatch({ type: "prepend", log });
    });

    return () => es.close();
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
    <div style={{ height: "100vh", display: "grid", gridTemplateRows: "56px 1fr" }}>
      <header style={{ display: "flex", gap: 12, alignItems: "center", padding: "0 16px", borderBottom: "1px solid #eee" }}>
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
        <button onClick={onMock}>+ mock</button>
        <button onClick={onClear}>clear</button>
      </header>

      <main style={{ display: "grid", gridTemplateColumns: "420px 1fr", minHeight: 0 }}>
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
                  cursor: "pointer"
                }}
              >
                <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                  <span style={{ width: 56, fontWeight: 700 }}>{x.method}</span>
                  <span style={{ width: 52, opacity: 0.8 }}>{x.status ?? "-"}</span>
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {x.host}{x.path}
                  </span>
                </div>
                <div style={{ marginTop: 4, fontSize: 12, opacity: 0.7 }}>
                  {new Date(x.ts).toLocaleTimeString()} · {x.durationMs ?? "-"} ms
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

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <KV title="Request Headers" obj={selected.request.headers} />
                <KV title="Response Headers" obj={selected.response?.headers ?? {}} />
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <JSONBlock title="Query" value={selected.request.query ?? {}} />
                <JSONBlock title="Timing" value={{ status: selected.status, durationMs: selected.durationMs }} />
              </div>

              <JSONBlock title="Request Body" value={selected.request.body ?? {}} />
              <JSONBlock title="Response Body" value={selected.response?.body ?? {}} />
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
            <div key={k} style={{ display: "grid", gridTemplateColumns: "160px 1fr", gap: 10, padding: "4px 0" }}>
              <div style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12, opacity: 0.8 }}>
                {k}
              </div>
              <div style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12, wordBreak: "break-all" }}>
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
      <pre style={{ border: "1px solid #eee", borderRadius: 8, padding: 10, overflow: "auto" }}>
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}
