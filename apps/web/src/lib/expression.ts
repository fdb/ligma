/**
 * Evaluates simple arithmetic expressions for number fields: 12*2, 100/3,
 * (4+5)*2, -8+3. Returns null for anything that doesn't parse cleanly.
 * Grammar: expr = term (('+'|'-') term)*; term = factor (('*'|'/') factor)*;
 * factor = '-' factor | '(' expr ')' | number.
 */
export function evaluateExpression(raw: string): number | null {
  // Tolerate a trailing unit suffix like "50%" or "12px".
  const src = raw.trim().replace(/(%|px)$/i, "").replace(/\s+/g, "");
  if (!src) return null;
  let i = 0;

  const peek = () => src[i];
  const number = (): number => {
    const m = /^\d*\.?\d+/.exec(src.slice(i));
    if (!m) throw new Error("expected number");
    i += m[0].length;
    return parseFloat(m[0]);
  };
  const factor = (): number => {
    if (peek() === "-") {
      i++;
      return -factor();
    }
    if (peek() === "(") {
      i++;
      const v = expr();
      if (peek() !== ")") throw new Error("expected )");
      i++;
      return v;
    }
    return number();
  };
  const term = (): number => {
    let v = factor();
    while (peek() === "*" || peek() === "/") {
      v = src[i++] === "*" ? v * factor() : v / factor();
    }
    return v;
  };
  const expr = (): number => {
    let v = term();
    while (peek() === "+" || peek() === "-") {
      v = src[i++] === "+" ? v + term() : v - term();
    }
    return v;
  };

  try {
    const v = expr();
    return i === src.length && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}
