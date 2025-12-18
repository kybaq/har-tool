import http from "http";
import https from "https";
import net from "net";
import dns from "dns";
import { nanoid } from "nanoid";
import type { RequestLog } from "@pkg/shared";

type PushLog = (log: RequestLog) => void;

const BODY_LIMIT = 64 * 1024; // 64KB
const UPSTREAM_TIMEOUT_MS = 15_000;

const HOP_BY_HOP = new Set([
  "connection",
  "proxy-connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
]);

function stripHopByHop(headers: Record<string, any>) {
  // remove headers listed in "Connection"
  const conn = headers["connection"] ?? headers["Connection"];
  if (conn) {
    String(conn)
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
      .forEach((h) => {
        delete headers[h];
        delete headers[h.toLowerCase()];
      });
  }

  for (const k of Object.keys(headers)) {
    if (HOP_BY_HOP.has(k.toLowerCase())) delete headers[k];
  }
  delete headers["connection"];
  delete headers["Connection"];
  delete headers["proxy-connection"];
  delete headers["Proxy-Connection"];
}

function headersToRecord(h: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (v == null) continue;
    out[k] = Array.isArray(v) ? v.join(", ") : String(v);
  }
  return out;
}

function captureLimitedText(chunks: Buffer[]): string {
  if (!chunks.length) return "";
  const buf = Buffer.concat(chunks);
  return buf.toString("utf8");
}

function safeUrlFromRequest(req: http.IncomingMessage): URL | null {
  // Proxy requests often use absolute-form: "http://example.com/path"
  // Some clients may use origin-form: "/path" + Host header.
  const raw = req.url || "";
  try {
    return new URL(raw);
  } catch {
    const host = req.headers.host;
    if (!host) return null;
    try {
      // For forward proxy with origin-form, assume http target.
      // (Browsers generally use absolute-form for proxy HTTP requests.)
      return new URL(`http://${host}${raw.startsWith("/") ? raw : `/${raw}`}`);
    } catch {
      return null;
    }
  }
}

// keep-alive agents to reduce handshake churn
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 64 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 64 });

// Prefer IPv4 in environments where IPv6 routes are flaky (often WSL/corp)
const lookupIPv4First = (
  hostname: string,
  options: any,
  cb: (
    err: NodeJS.ErrnoException | null,
    address: string,
    family: number
  ) => void
) => {
  dns.lookup(hostname, { ...options, family: 4 }, cb);
};

export function startForwardProxy(proxyPort: number, pushLog: PushLog) {
  const server = http.createServer((clientReq, clientRes) => {
    const id = nanoid();
    const ts = Date.now();
    const start = Date.now();

    const targetUrl = safeUrlFromRequest(clientReq);
    if (!targetUrl) {
      clientRes.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      clientRes.end("Bad Request: invalid url/host");
      return;
    }

    const isHttps = targetUrl.protocol === "https:";
    const upstreamLib = isHttps ? https : http;
    const agent = isHttps ? httpsAgent : httpAgent;

    // Build upstream request options
    const reqHeaders: Record<string, any> = { ...clientReq.headers };

    // Proxy-only header cleanup
    stripHopByHop(reqHeaders);

    // Some servers dislike absolute-form in request line; we send origin-form path to upstream
    const upstreamPath = targetUrl.pathname + targetUrl.search;

    // Capture request body (limited)
    const reqBodyChunks: Buffer[] = [];
    let reqBodySize = 0;

    clientReq.on("data", (chunk: Buffer) => {
      if (reqBodySize < BODY_LIMIT) {
        const remain = BODY_LIMIT - reqBodySize;
        reqBodyChunks.push(chunk.subarray(0, remain));
      }
      reqBodySize += chunk.length;
    });

    let done = false;
    const finishOnce = () => {
      if (done) return false;
      done = true;
      return true;
    };

    const safeFail = (status: number, msg: string) => {
      // make sure we only fail once
      if (!finishOnce()) return;

      // If response already started, just tear down
      if (clientRes.headersSent || clientRes.writableEnded) {
        try {
          clientRes.destroy();
        } catch {}
        return;
      }

      clientRes.writeHead(status, {
        "content-type": "text/plain; charset=utf-8",
      });
      clientRes.end(msg);
    };

    // Debug (optional)
    // console.log("[proxy] req", clientReq.method, clientReq.url, "host:", clientReq.headers.host);

    const upstreamReq = upstreamLib.request(
      {
        protocol: targetUrl.protocol,
        hostname: targetUrl.hostname,
        port: targetUrl.port || (isHttps ? 443 : 80),
        method: clientReq.method,
        path: upstreamPath,
        headers: reqHeaders,
        agent,
        lookup: lookupIPv4First,
      },
      (upstreamRes) => {
        // Write headers first, then stream body
        const resHeaders: Record<string, any> = { ...upstreamRes.headers };
        stripHopByHop(resHeaders);

        if (!clientRes.headersSent) {
          clientRes.writeHead(upstreamRes.statusCode || 0, resHeaders);
        }

        // Capture response body (limited)
        const resBodyChunks: Buffer[] = [];
        let resBodySize = 0;

        upstreamRes.on("data", (chunk: Buffer) => {
          if (resBodySize < BODY_LIMIT) {
            const remain = BODY_LIMIT - resBodySize;
            resBodyChunks.push(chunk.subarray(0, remain));
          }
          resBodySize += chunk.length;
        });

        // Stream upstream to client
        upstreamRes.pipe(clientRes);

        upstreamRes.on("end", () => {
          // we consider this request finished (success path)
          if (!finishOnce()) return;

          const durationMs = Date.now() - start;

          const log: RequestLog = {
            id,
            ts,
            method: (clientReq.method || "GET") as any,
            url: targetUrl.toString(),
            host: targetUrl.host,
            path: targetUrl.pathname,
            status: upstreamRes.statusCode,
            durationMs,
            request: {
              headers: headersToRecord(clientReq.headers),
              query: Object.fromEntries(targetUrl.searchParams.entries()),
              body: {
                mime: String(clientReq.headers["content-type"] || ""),
                text: captureLimitedText(reqBodyChunks),
              },
            },
            response: {
              headers: headersToRecord(upstreamRes.headers),
              body: {
                mime: String(upstreamRes.headers["content-type"] || ""),
                text: captureLimitedText(resBodyChunks),
              },
            },
          };

          pushLog(log);
        });

        upstreamRes.on("error", (err: any) => {
          console.error("[proxy] upstreamRes error", {
            code: err?.code,
            message: err?.message,
          });
          safeFail(
            502,
            `Bad Gateway: ${err?.code ?? ""} ${err?.message ?? String(err)}`
          );
        });
      }
    );

    upstreamReq.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
      const err: any = new Error("upstream timeout");
      err.code = "ETIMEDOUT";
      upstreamReq.destroy(err);
    });

    upstreamReq.on("error", (err: any) => {
      // log and fail safely (no headers-sent crash)
      console.error("[proxy] upstream error", {
        code: err?.code,
        message: err?.message,
        host: targetUrl.host,
        port: targetUrl.port || (isHttps ? 443 : 80),
        url: targetUrl.toString(),
      });

      safeFail(
        502,
        `Bad Gateway: ${err?.code ?? ""} ${err?.message ?? String(err)}`
      );

      // also push a minimal log (best-effort)
      const durationMs = Date.now() - start;
      pushLog({
        id,
        ts,
        method: (clientReq.method || "GET") as any,
        url: targetUrl.toString(),
        host: targetUrl.host,
        path: targetUrl.pathname,
        status: 502,
        durationMs,
        request: {
          headers: headersToRecord(clientReq.headers),
          query: Object.fromEntries(targetUrl.searchParams.entries()),
        },
        response: {
          headers: {},
          body: {
            mime: "text/plain",
            text: `Bad Gateway: ${err?.code ?? ""} ${err?.message ?? ""}`,
          },
        },
      });
    });

    // Forward request body to upstream
    clientReq.pipe(upstreamReq);

    // If client aborts, abort upstream as well
    clientReq.on("aborted", () => {
      try {
        upstreamReq.destroy();
      } catch {}
    });
    clientRes.on("close", () => {
      // close may happen after end; safe
      try {
        upstreamReq.destroy();
      } catch {}
    });
  });

  // HTTPS tunneling via CONNECT (no MITM here)
  server.on("connect", (req, clientSocket, head) => {
    const id = nanoid();
    const ts = Date.now();
    const start = Date.now();

    const [host, portStr] = (req.url || "").split(":");
    const port = Number(portStr || 443) || 443;

    let finished = false;
    const finish = (status: number) => {
      if (finished) return;
      finished = true;

      const durationMs = Date.now() - start;
      pushLog({
        id,
        ts,
        method: "CONNECT" as any,
        url: `https://${host}:${port}`,
        host: `${host}:${port}`,
        path: "",
        status,
        durationMs,
        request: { headers: headersToRecord(req.headers) },
        response: { headers: {}, body: { mime: "", text: "" } },
      });
    };

    const serverSocket = net.connect(port, host, () => {
      // Tell client tunnel is established
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");

      // Forward any buffered data
      if (head && head.length) serverSocket.write(head);

      // Pipe both ways
      serverSocket.pipe(clientSocket);
      clientSocket.pipe(serverSocket);

      finish(200);
    });

    const onError = (err: any) => {
      console.error("[proxy] CONNECT error", {
        code: err?.code,
        message: err?.message,
        host,
        port,
      });
      try {
        clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      } catch {}
      try {
        clientSocket.destroy();
      } catch {}
      try {
        serverSocket.destroy();
      } catch {}
      finish(502);
    };

    serverSocket.on("error", onError);
    clientSocket.on("error", onError);

    clientSocket.on("close", () => {
      try {
        serverSocket.destroy();
      } catch {}
    });
    serverSocket.on("close", () => {
      try {
        clientSocket.destroy();
      } catch {}
    });
  });

  server.on("clientError", (err, socket) => {
    console.error("[proxy] clientError", err?.message || err);
    try {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    } catch {}
  });

  server.on("error", (err) => {
    console.error("[proxy] listen error:", err);
  });

  server.listen(proxyPort, "127.0.0.1", () => {
    console.log(`[proxy] http://127.0.0.1:${proxyPort}`);
  });

  return server;
}
