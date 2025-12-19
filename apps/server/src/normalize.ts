export function normalizePath(path: string) {
  // strip trailing slash except root
  const clean = path.length > 1 ? path.replace(/\/+$/, "") : path;

  const parts = clean.split("/").map((seg) => {
    if (!seg) return seg;

    // uuid v4-ish
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(seg)) {
      return ":uuid";
    }

    // long hex hash (16+)
    if (/^[0-9a-f]{16,}$/i.test(seg)) {
      return ":hash";
    }

    // numeric id
    if (/^\d+$/.test(seg)) {
      return ":id";
    }

    return seg;
  });

  return parts.join("/");
}

export function queryKeys(url: URL) {
  const keys = Array.from(url.searchParams.keys());
  keys.sort();
  // 중복 제거
  return Array.from(new Set(keys));
}
