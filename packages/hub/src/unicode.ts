import type { Dialect } from "./shell.js";

export type CodeRange = readonly [from: number, to: number];

export const powershellSpaces: readonly CodeRange[] = [
  [0x0009, 0x0009],
  [0x000b, 0x000c],
  [0x0020, 0x0020],
  [0x0085, 0x0085],
  [0x00a0, 0x00a0],
  [0x1680, 0x1680],
  [0x2000, 0x200a],
  [0x2028, 0x2029],
  [0x202f, 0x202f],
  [0x205f, 0x205f],
  [0x3000, 0x3000],
];

export const powershellDashes: readonly CodeRange[] = [
  [0x002d, 0x002d],
  [0x2013, 0x2015],
];

export const powershellSingleQuotes: readonly CodeRange[] = [
  [0x0027, 0x0027],
  [0x2018, 0x201b],
];

export const powershellDoubleQuotes: readonly CodeRange[] = [
  [0x0022, 0x0022],
  [0x201c, 0x201e],
];

export const cmdSpaces: readonly CodeRange[] = [
  [0x0009, 0x0009],
  [0x000b, 0x000c],
  [0x0020, 0x0020],
  [0x0085, 0x0085],
  [0x00a0, 0x00a0],
  [0x1680, 0x1680],
  [0x180e, 0x180e],
  [0x2000, 0x200a],
  [0x2028, 0x2029],
  [0x202f, 0x202f],
  [0x205f, 0x205f],
  [0x3000, 0x3000],
];

export const invisibleCharacters: readonly CodeRange[] = [
  [0x00ad, 0x00ad],
  [0x034f, 0x034f],
  [0x061c, 0x061c],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180b, 0x180d],
  [0x180f, 0x180f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x206f],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xfff9, 0xfffb],
  [0x1bca0, 0x1bca3],
  [0x1d173, 0x1d17a],
  [0xe0000, 0xe007f],
  [0xe0100, 0xe01ef],
];

export const spaceLookAlikes: readonly CodeRange[] = cmdSpaces.filter(([from]) => from > 0x7f);

export const dashLookAlikes: readonly CodeRange[] = [
  [0x02d7, 0x02d7],
  [0x2010, 0x2015],
  [0x2043, 0x2043],
  [0x2212, 0x2212],
  [0xfe58, 0xfe58],
  [0xfe63, 0xfe63],
  [0xff0d, 0xff0d],
];

export const quoteLookAlikes: readonly CodeRange[] = [
  [0x02b9, 0x02ba],
  [0x02bb, 0x02bc],
  [0x02c8, 0x02c8],
  [0x2018, 0x201f],
  [0x2032, 0x2033],
  [0x2035, 0x2036],
  [0xff02, 0xff02],
  [0xff07, 0xff07],
];

export const slashLookAlikes: readonly CodeRange[] = [
  [0x2044, 0x2044],
  [0x2215, 0x2215],
  [0x29f8, 0x29f8],
];

export const letterLookAlikes: Readonly<Record<string, string>> = {
  "а": "a",
  "в": "b",
  "е": "e",
  "к": "k",
  "м": "m",
  "н": "h",
  "о": "o",
  "р": "p",
  "с": "c",
  "т": "t",
  "у": "y",
  "х": "x",
  "ѕ": "s",
  "і": "i",
  "ј": "j",
  "һ": "h",
  "ӏ": "l",
  "ԁ": "d",
  "ԛ": "q",
  "ԝ": "w",
  "А": "A",
  "В": "B",
  "Е": "E",
  "К": "K",
  "М": "M",
  "Н": "H",
  "О": "O",
  "Р": "P",
  "С": "C",
  "Т": "T",
  "Х": "X",
  "Ѕ": "S",
  "І": "I",
  "Ј": "J",
  "Ү": "Y",
  "Ԛ": "Q",
  "Ԝ": "W",
  "α": "a",
  "ι": "i",
  "κ": "k",
  "ν": "v",
  "ο": "o",
  "ρ": "p",
  "υ": "u",
  "χ": "x",
  "Α": "A",
  "Β": "B",
  "Ε": "E",
  "Ζ": "Z",
  "Η": "H",
  "Ι": "I",
  "Κ": "K",
  "Μ": "M",
  "Ν": "N",
  "Ο": "O",
  "Ρ": "P",
  "Τ": "T",
  "Υ": "Y",
  "Χ": "X",
  "հ": "h",
  "ո": "n",
  "ս": "u",
  "օ": "o",
  "ı": "i",
  "ȷ": "j",
  "ɡ": "g",
  "ɩ": "i",
  "ɪ": "i",
  "ᴀ": "a",
  "ᴄ": "c",
  "ᴅ": "d",
  "ᴇ": "e",
  "ᴋ": "k",
  "ᴍ": "m",
  "ᴏ": "o",
  "ᴘ": "p",
  "ᴛ": "t",
  "ᴜ": "u",
  "ᴠ": "v",
  "ᴡ": "w",
  "ᴢ": "z",
};

export const compatibilityTargets = /^[A-Za-z0-9 .,:;|&=+~@%!_*/-]+$/;

function codeSet(ranges: readonly CodeRange[]): ReadonlySet<number> {
  const set = new Set<number>();
  for (const [from, to] of ranges) {
    for (let code = from; code <= to; code += 1) {
      set.add(code);
    }
  }
  return set;
}

export interface CharacterClass {
  has(char: string | undefined): boolean;
}

function characterClass(ranges: readonly CodeRange[]): CharacterClass {
  const set = codeSet(ranges);
  return { has: (char) => char !== undefined && char.length > 0 && set.has(char.codePointAt(0) ?? -1) };
}

export const powershellSpace = characterClass(powershellSpaces);

export const powershellDash = characterClass(powershellDashes);

export const powershellSingleQuote = characterClass(powershellSingleQuotes);

export const powershellDoubleQuote = characterClass(powershellDoubleQuotes);

const cmdSpace = characterClass(cmdSpaces);

const invisible = characterClass(invisibleCharacters);

const spaceLike = characterClass(spaceLookAlikes);

const dashLike = characterClass(dashLookAlikes);

const quoteLike = characterClass(quoteLookAlikes);

const slashLike = characterClass(slashLookAlikes);

function ascii(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) > 0x7f) {
      return false;
    }
  }
  return true;
}

export function cmdSpacesAsSpaces(text: string): string {
  if (ascii(text)) {
    return text;
  }
  let out = "";
  for (const char of text) {
    out += cmdSpace.has(char) ? " " : char;
  }
  return out;
}

function foldCharacter(char: string, reader: Dialect): string {
  if (invisible.has(char)) {
    return "";
  }
  if (spaceLike.has(char)) {
    return " ";
  }
  if (dashLike.has(char)) {
    return "-";
  }
  if (quoteLike.has(char)) {
    return reader === "powershell" && (powershellSingleQuote.has(char) || powershellDoubleQuote.has(char)) ? char : "";
  }
  if (slashLike.has(char)) {
    return "/";
  }
  const letter = letterLookAlikes[char];
  if (letter !== undefined) {
    return letter;
  }
  const compatible = char.normalize("NFKC");
  return compatible !== char && compatibilityTargets.test(compatible) ? compatible : char;
}

export function foldLookAlikes(text: string, reader: Dialect): string {
  if (ascii(text)) {
    return text;
  }
  let out = "";
  for (const char of text) {
    out += char.charCodeAt(0) < 0x80 ? char : foldCharacter(char, reader);
  }
  return out;
}
