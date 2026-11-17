export interface RawSegment {
  readonly text: string;
  readonly hidden: boolean;
}

const looksBlank = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Zs}⠀ᅟᅠㅤﾠ]/u;

const plain: ReadonlySet<string> = new Set(["\n", "\t", " "]);

export function codePointLabel(character: string): string {
  const point = character.codePointAt(0) ?? 0;
  return `U+${point.toString(16).toUpperCase().padStart(4, "0")}`;
}

export function rawSegments(command: string): RawSegment[] {
  const segments: RawSegment[] = [];
  const characters = [...command];
  characters.forEach((character, index) => {
    const hidden = !plain.has(character) && looksBlank.test(character) && !(character === "\r" && characters[index + 1] === "\n");
    const piece = hidden ? codePointLabel(character) : character;
    const last = segments.at(-1);
    if (last !== undefined && last.hidden === hidden && !hidden) {
      segments[segments.length - 1] = { text: last.text + piece, hidden };
    } else {
      segments.push({ text: piece, hidden });
    }
  });
  return segments;
}
