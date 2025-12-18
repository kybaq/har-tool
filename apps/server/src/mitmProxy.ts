import { Proxy } from "http-mitm-proxy";
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import type { RequestLog } from "@pkg/shared";

type PushLog = (log: RequestLog) => void;

const BODY_LIMIT = 64 * 1024;

function toRecord(headers: any): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  for (const [k, v] of Object.entries(headers)) {
    if (v == null) continue;
    out[String(k).toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
  }
  return out;
}

function captureLimited(buf: Buffer[], limit = BODY_LIMIT) {
  const b = Buffer.concat(buf);
  const sliced = b.subarray(0, limit);
  return sliced.toString("utf8"); // MVP: 텍스트로만 저장(바이너리는 다음 단계)
}

export function startMitmProxy(opts: { port: number; pushLog: PushLog }) {
  const { port, pushLog } = opts;

  // http-mitm-proxy는 기본적으로 ./certs 아래에 CA/도메인 인증서 저장 가능
  const certDir = path.join(process.cwd(), "certs");
  fs.mkdirSync(certDir, { recursive: true });

  const proxy = new Proxy();

  proxy.onError((ctx, err, kind) => {
    if ((err as any)?.code === "EPIPE") {
      // 브라우저가 먼저 연결을 닫은 정상적인 케이스
      return;
    }
    console.error("[mitm] error", kind, err);
  });

  proxy.onRequest((ctx, callback) => {
    const id = nanoid();
    const ts = Date.now();
    const start = Date.now();

    // ctx.clientToProxyRequest.url 은 보통 path 형태.
    // 전체 URL은 host + url로 조합
    const req = ctx.clientToProxyRequest;
    const host = req.headers?.host || "";
    const isTls = Boolean(ctx.isSSL);
    const protocol = isTls ? "https" : "http";
    const fullUrl = `${protocol}://${host}${req.url || ""}`;

    // 요청 body 캡처
    const reqChunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      if (Buffer.concat(reqChunks).length < BODY_LIMIT) reqChunks.push(chunk);
    });

    // 응답 캡처를 위해 hook
    ctx.onResponseData((ctx2, chunk, cb) => {
      // 응답 바디는 ctx2.state에 저장
      const state = (ctx2 as any).state || ((ctx2 as any).state = {});
      const arr: Buffer[] = state.resChunks || (state.resChunks = []);
      if (Buffer.concat(arr).length < BODY_LIMIT) arr.push(Buffer.from(chunk));
      cb(null, chunk);
    });

    ctx.onResponseEnd((ctx2, cb) => {
      const durationMs = Date.now() - start;

      const res = ctx2.serverToProxyResponse;
      const state = (ctx2 as any).state || {};
      const resChunks: Buffer[] = state.resChunks || [];

      // 상태코드/헤더
      const status = res?.statusCode;

      const urlObj = new URL(fullUrl);
      const log: RequestLog = {
        id,
        ts,
        method: (req.method || "GET") as any,
        url: fullUrl,
        host: urlObj.host,
        path: urlObj.pathname,
        status,
        durationMs,
        request: {
          headers: toRecord(req.headers),
          query: Object.fromEntries(urlObj.searchParams.entries()),
          body: {
            mime: String(req.headers?.["content-type"] || ""),
            text: captureLimited(reqChunks),
          },
        },
        response: {
          headers: toRecord(res?.headers),
          body: {
            mime: String(res?.headers?.["content-type"] || ""),
            text: captureLimited(resChunks),
          },
        },
      };

      pushLog(log);
      cb();
    });

    callback();
  });

  proxy.listen({ port }, () => {
    console.log(`[mitm] listening on http://127.0.0.1:${port}`);
    console.log(`[mitm] certs directory: ${certDir}`);
  });

  return proxy;
}
