export function characterLength(text: string): number {
  return [...text.trim()].length;
}

export function endsWithQuestion(value: string): boolean {
  const lines = value.trim().split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
  const last = lines.at(-1) ?? "";
  return /[?？]\s*[)）】"”'*_`]*$/.test(last) || /[?？]/.test(last.slice(-40));
}

export type ReferenceKind = "tkt" | "t" | "ticket" | "issue" | "number";

export interface Reference {
  readonly kind: ReferenceKind;
  readonly value: string;
  readonly key: string;
}

const unitAfterNumber = /^\s*(个|轮|次|项|条|张|小时|分钟|分|秒|天|号|月|年|点|岁|万|千|百|%|ms\b|s\b|k\b|g\b|gb\b|mb\b|kb\b|px\b)/i;

export function namedReferences(text: string, bare: boolean): Reference[] {
  const found: Reference[] = [];
  for (const match of text.matchAll(/tkt_([0-9a-f]{6,})/gi)) {
    const value = match[1]!.slice(0, 8).toLowerCase();
    found.push({ kind: "tkt", value, key: `tkt:${value}` });
  }
  for (const match of text.matchAll(/\bT-(\d{1,5})\b/g)) {
    const value = String(Number(match[1]));
    found.push({ kind: "t", value, key: `t:${value}` });
  }
  for (const match of text.matchAll(/(#|工单\s*|issue\s*|PR\s*#?)(\d{1,5})(?![\d.:])/gi)) {
    const value = String(Number(match[2]));
    found.push({ kind: match[1]!.startsWith("工单") ? "ticket" : "issue", value, key: `n:${value}` });
  }
  if (bare) {
    for (const match of text.matchAll(/(?<![\d.:#\w-])(\d{2,4})(?![\d.:%\w-])/g)) {
      const rest = text.slice((match.index ?? 0) + match[0].length);
      if (!unitAfterNumber.test(rest)) {
        const value = String(Number(match[1]));
        found.push({ kind: "number", value, key: `n:${value}` });
      }
    }
  }
  return found;
}

export function referencesIn(text: string, bare: boolean): Set<string> {
  return new Set(namedReferences(text, bare).map((reference) => reference.key));
}
