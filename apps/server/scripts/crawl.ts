import { chromium, type Page } from "@playwright/test"

const BASE = process.env.BASE_URL || "https://example.com";
const API = process.env.SERVER_URL || "http://127.0.0.1:8787";
const MAX_PAGES = Number(process.env.MAX_PAGES || 200);
const MAX_DEPTH = Number(process.env.MAX_DEPTH || 4);

function norm(u: string) {
  try {
    const url = new URL(u, BASE);
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function routeKeyFromUrl(u: string) {
  const url = new URL(u);
  // 쿼리는 라우트 분류에서 제외(원하면 포함 가능)
  return url.pathname || "/";
}

async function startSession(routeKey: string) {
  const r = await fetch(`${API}/api/sessions/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ routeKey, name: `auto ${routeKey}` }),
  });
  return r.json(); // meta (id 포함)
}

async function stopSession() {
  await fetch(`${API}/api/sessions/stop`, { method: "POST" });
}

async function makeReport(sessionId: string) {
  const r = await fetch(`${API}/api/sessions/${sessionId}/report`, { method: "POST" });
  return r.json();
}

async function collectLinks(page: Page) {
  const hrefs = await page.$$eval("a[href]", (as) =>
    as.map((a) => (a as HTMLAnchorElement).href).filter(Boolean)
  );
  return hrefs;
}

async function smokeActions(page: Page) {
  // “대표 액션” 최소 세트 (안전하게)
  await page.waitForTimeout(300);
  await page.mouse.wheel(0, 1200).catch(() => {});
  await page.waitForTimeout(200);

  // 탭/버튼류 조금 눌러보기(너무 공격적으로 하지 않음)
  const candidates = await page.$$("button, [role='button']");
  for (let i = 0; i < Math.min(candidates.length, 3); i++) {
    try {
      await candidates[i].click({ timeout: 800 });
      await page.waitForTimeout(300);
    } catch {}
  }
}

async function gotoAndCapture(page: Page, url: string) {
  const key = routeKeyFromUrl(url);

  const meta = await startSession(key);
  const sessionId = meta?.id;

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    await smokeActions(page);
  } finally {
    await stopSession();
  }

  if (sessionId) {
    await makeReport(sessionId).catch(() => {});
  }
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    proxy: { server: "http://127.0.0.1:8888" }, // 너의 MITM 프록시
  });

  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    // 로그인 상태를 저장했다면 아래 주석 해제
    // storageState: "state.json",
  });

  const page = await context.newPage();

  const seen = new Set<string>();
  const queue: Array<{ url: string; depth: number }> = [{ url: BASE, depth: 0 }];

  while (queue.length && seen.size < MAX_PAGES) {
    const { url, depth } = queue.shift()!;
    const u = norm(url);
    if (!u) continue;
    if (seen.has(u)) continue;
    if (depth > MAX_DEPTH) continue;

    // same-origin만
    if (new URL(u).origin !== new URL(BASE).origin) continue;

    seen.add(u);

    await gotoAndCapture(page, u);

    // 링크 수집
    const links = await collectLinks(page).catch(() => []);
    for (const link of links) {
      const nu = norm(link);
      if (!nu) continue;
      if (new URL(nu).origin !== new URL(BASE).origin) continue;
      if (!seen.has(nu)) queue.push({ url: nu, depth: depth + 1 });
    }
  }

  await browser.close();
  console.log("done. visited:", seen.size);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
