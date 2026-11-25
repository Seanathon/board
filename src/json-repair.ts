/**
 * Narrow, deletion-only repair for near-valid JSON from a model.
 *
 * Models that are allowed to omit optional fields sometimes half-omit one: they
 * emit the key and then drop its value (`"key",` or `"key": ,`), or leave a
 * trailing comma. A strict `JSON.parse` then rejects the whole response and every
 * good field in it is lost.
 *
 * The repairs here ONLY DELETE malformed pairs or stray commas. They never alter,
 * guess, or invent a value, so a repaired parse contains a subset of what the model
 * actually wrote and provenance is unchanged. Anything else is rethrown as the
 * original SyntaxError. Each repair is reported (by key name only, never a value)
 * so callers can log or store it.
 */
export interface JsonRepair {
  kind: 'dangling-key' | 'trailing-comma';
  /** The dropped key, for `dangling-key` (a JSON string body; never a value). */
  key?: string;
}

export interface RepairedJson {
  value: unknown;
  repairs: JsonRepair[];
}

/** Bound on repairs so a pathological response can't loop. */
const MAX_REPAIRS = 24;

const isWs = (c: string | undefined): boolean => c === ' ' || c === '\n' || c === '\r' || c === '\t';

/** Index of the last non-whitespace char strictly before `index`, or -1. */
function prevNonWs(text: string, index: number): number {
  let i = index - 1;
  while (i >= 0 && isWs(text[i])) i--;
  return i;
}

/** Start index of the JSON string literal that ends (closing quote) at `end`, or -1. */
function stringStart(text: string, end: number): number {
  if (text[end] !== '"') return -1;
  for (let i = end - 1; i >= 0; i--) {
    if (text[i] !== '"') continue;
    let slashes = 0;
    for (let j = i - 1; j >= 0 && text[j] === '\\'; j--) slashes++;
    if (slashes % 2 === 0) return i; // unescaped opening quote
  }
  return -1;
}

function errorPosition(err: SyntaxError): number | undefined {
  const m = /position (\d+)/.exec(err.message);
  return m ? Number(m[1]) : undefined;
}

/**
 * V8 omits the position for some errors ("Unexpected token ',' ..."). Find the first
 * structurally empty slot instead: a `,`/`}` right after `:`, or a `}`/`]` right after
 * `,`, ignoring everything inside string literals.
 */
function findEmptySlot(text: string): number | undefined {
  let inString = false;
  let last = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') { inString = false; last = '"'; }
      continue;
    }
    if (isWs(c)) continue;
    if (c === '"') { inString = true; continue; }
    if ((last === ':' && (c === ',' || c === '}')) || (last === ',' && (c === '}' || c === ']'))) return i;
    last = c;
  }
  return undefined;
}

/** Remove `[from, to)` and any whitespace that directly follows it. */
function cut(text: string, from: number, to: number): string {
  let end = to;
  while (isWs(text[end])) end++;
  return text.slice(0, from) + text.slice(end);
}

function repairAt(text: string, pos: number): { text: string; repair: JsonRepair } | undefined {
  const at = text[pos];
  if (at === undefined) return undefined;
  const before = prevNonWs(text, pos);
  if (before < 0) return undefined;

  // Stray comma directly before a closing brace/bracket: `{"a":1,}` / `[1,]`.
  if ((at === '}' || at === ']') && text[before] === ',') {
    return { text: text.slice(0, before) + text.slice(before + 1), repair: { kind: 'trailing-comma' } };
  }

  // A key whose value was dropped: `"key",` / `"key"}` / `"key": ,` / `"key": }`.
  if (at === ',' || at === '}') {
    let keyEnd = before;
    if (text[keyEnd] === ':') keyEnd = prevNonWs(text, keyEnd);
    const start = stringStart(text, keyEnd);
    if (start < 0) return undefined;
    const lead = prevNonWs(text, start);
    // Only drop it when it is positioned as an object key.
    if (lead < 0 || (text[lead] !== '{' && text[lead] !== ',')) return undefined;
    // Model-controlled text: keep it short and printable before it can reach a log line.
    const key = text.slice(start + 1, keyEnd).replace(/[^\x20-\x7e]/g, '?').slice(0, 80);
    if (at === ',') {
      return { text: cut(text, start, pos + 1), repair: { kind: 'dangling-key', key } };
    }
    // `at === '}'`: drop the key and the comma that introduced it, if any.
    const from = text[lead] === ',' ? lead : start;
    return { text: text.slice(0, from) + text.slice(pos), repair: { kind: 'dangling-key', key } };
  }
  return undefined;
}

/**
 * Parse `candidate` as JSON, applying the deletion-only repairs above when strict
 * parsing fails. Throws the ORIGINAL SyntaxError if it cannot be repaired.
 */
export function parseJsonWithRepairs(candidate: string): RepairedJson {
  const repairs: JsonRepair[] = [];
  let text = candidate;
  let original: unknown;
  for (let attempt = 0; ; attempt++) {
    try {
      return { value: JSON.parse(text), repairs };
    } catch (err) {
      original ??= err;
      const pos = err instanceof SyntaxError ? (errorPosition(err) ?? findEmptySlot(text)) : undefined;
      const fix = pos === undefined || attempt >= MAX_REPAIRS ? undefined : repairAt(text, pos);
      if (!fix) throw original;
      text = fix.text;
      repairs.push(fix.repair);
    }
  }
}
