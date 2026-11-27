/** Native metadata must survive JSON transport without Infinity becoming null or deep data exhausting the stack. */
export function isLosslessLibraryJson(value: unknown): boolean {
  const pending = [{ value, depth: 0 }]; let visited = 0;
  while (pending.length) {
    const current = pending.pop(); if (!current) break;
    if (++visited > 100000 || current.depth > 32) return false;
    const item = current.value;
    if (item === null || item === undefined || typeof item === "string" || typeof item === "boolean") continue;
    if (typeof item === "number") { if (!Number.isFinite(item)) return false; continue; }
    if (typeof item !== "object") return false;
    const children = Object.values(item);
    if (children.length + pending.length + visited > 100000) return false;
    for (const child of children) pending.push({ value: child, depth: current.depth + 1 });
  }
  return true;
}
