/**
 * Checks that every meaningful number in a model reply appears in the data the tools returned
 * (or in the user's own message). The model explains numbers; it must not invent them.
 */
export function collectNumbers(value: unknown, out: number[] = []): number[] {
  if (typeof value === "number" && Number.isFinite(value)) {
    out.push(value, value * 100); // fractions are often stated as percentages
  } else if (typeof value === "string") {
    for (const m of value.matchAll(/-?\d[\d,]*(?:\.\d+)?/g)) out.push(Number(m[0].replace(/,/g, "")));
  } else if (Array.isArray(value)) {
    for (const v of value) collectNumbers(v, out);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) collectNumbers(v, out);
  }
  return out;
}

export function ungroundedNumbers(reply: string, grounding: number[]): string[] {
  const bad: string[] = [];
  for (const m of reply.matchAll(/\$?-?\d[\d,]*(?:\.\d+)?%?/g)) {
    const raw = m[0];
    const n = Math.abs(Number(raw.replace(/[$,%]/g, "")));
    if (!Number.isFinite(n)) continue;
    if (Number.isInteger(n) && n <= 24 && !raw.includes("%") && !raw.includes("$")) continue; // counts, hours, list labels
    const ok = grounding.some((g) => {
      const a = Math.abs(g);
      if (a === n) return true;
      const tol = Math.max(0.011, a * 0.012); // rounding to 2 decimals / ~1%
      return Math.abs(a - n) <= tol;
    });
    if (!ok) bad.push(raw);
  }
  return bad;
}
