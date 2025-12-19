import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import type { RequestLog } from "@pkg/shared";
import type { RouteReport } from "./routeReport";

export type SessionMeta = {
  id: string;
  name: string;
  createdAt: number;
  endedAt?: number;
  logCount: number;
  dir: string;
  logsPath: string;
};

const DEFAULT_ROOT = path.resolve(process.cwd(), "data", "sessions");

export class SessionStore {
  private rootDir: string;
  private current: SessionMeta | null = null;
  private writeStream: fs.WriteStream | null = null;

  constructor(rootDir = DEFAULT_ROOT) {
    this.rootDir = rootDir;
  }

  async init() {
    await fsp.mkdir(this.rootDir, { recursive: true });
  }

  getCurrent() {
    return this.current;
  }

  async list(): Promise<SessionMeta[]> {
    await this.init();
    const entries = await fsp.readdir(this.rootDir, { withFileTypes: true });
    const metas: SessionMeta[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const metaPath = path.join(this.rootDir, e.name, "meta.json");
      try {
        const txt = await fsp.readFile(metaPath, "utf8");
        metas.push(JSON.parse(txt));
      } catch {
        // ignore broken session dirs
      }
    }
    // 최신순
    metas.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    return metas;
  }

  async read(id: string): Promise<SessionMeta | null> {
    const metaPath = path.join(this.rootDir, id, "meta.json");
    try {
      return JSON.parse(await fsp.readFile(metaPath, "utf8"));
    } catch {
      return null;
    }
  }

  async start(name?: string): Promise<SessionMeta> {
    await this.init();

    // 이미 세션이 열려있으면 종료 후 새로 시작(정책)
    if (this.current) await this.stop();

    const id = nanoid();
    const createdAt = Date.now();
    const sessionName =
      name?.trim() || `Session ${new Date(createdAt).toLocaleString()}`;

    const dir = path.join(this.rootDir, id);
    await fsp.mkdir(dir, { recursive: true });

    const logsPath = path.join(dir, "logs.ndjson");

    const meta: SessionMeta = {
      id,
      name: sessionName,
      createdAt,
      logCount: 0,
      dir,
      logsPath,
    };

    await fsp.writeFile(
      path.join(dir, "meta.json"),
      JSON.stringify(meta, null, 2),
      "utf8"
    );

    this.writeStream = fs.createWriteStream(logsPath, { flags: "a" });
    this.current = meta;

    return meta;
  }

  async stop(): Promise<SessionMeta | null> {
    if (!this.current) return null;

    const endedAt = Date.now();
    const meta = { ...this.current, endedAt };

    await fsp.writeFile(
      path.join(meta.dir, "meta.json"),
      JSON.stringify(meta, null, 2),
      "utf8"
    );

    await new Promise<void>((resolve) => {
      if (!this.writeStream) return resolve();
      this.writeStream.end(() => resolve());
    });

    this.writeStream = null;
    this.current = null;

    return meta;
  }

  // pushLog에서 호출: 현재 세션이 열려있으면 파일에 append
  async append(log: RequestLog) {
    if (!this.current || !this.writeStream) return;

    // NDJSON: 한 줄에 하나
    this.writeStream.write(JSON.stringify(log) + "\n");

    // 메타 카운트 업데이트(너무 자주 쓰면 느리니 N개마다 flush해도 됨. MVP는 즉시)
    const updated: SessionMeta = {
      ...this.current,
      logCount: this.current.logCount + 1,
    };
    this.current = updated;
    await fsp.writeFile(
      path.join(updated.dir, "meta.json"),
      JSON.stringify(updated, null, 2),
      "utf8"
    );
  }

  async readLogs(id: string, limit = 500): Promise<RequestLog[]> {
    const meta = await this.read(id);
    if (!meta) return [];

    // 파일이 크면 스트리밍/뒤에서부터 읽는 게 좋지만 MVP는 간단히:
    const txt = await fsp.readFile(meta.logsPath, "utf8").catch(() => "");
    const lines = txt.trim().split("\n").filter(Boolean);

    // 최신을 먼저 보고 싶으면 뒤에서 limit개
    const slice = lines.slice(Math.max(0, lines.length - limit));
    const items: RequestLog[] = [];
    for (const line of slice) {
      try {
        items.push(JSON.parse(line));
      } catch {}
    }
    return items;
  }

  async readReport(id: string): Promise<RouteReport | null> {
    const meta = await this.read(id);
    if (!meta) return null;
    try {
      const txt = await fsp.readFile(path.join(meta.dir, "report.json"), "utf8");
      return JSON.parse(txt);
    } catch {
      return null;
    }
  }

  async writeReport(id: string, report: RouteReport): Promise<void> {
    const meta = await this.read(id);
    if (!meta) return;
    await fsp.writeFile(path.join(meta.dir, "report.json"), JSON.stringify(report, null, 2), "utf8");
  }
}
