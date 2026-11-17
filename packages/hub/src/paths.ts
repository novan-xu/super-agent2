import { unknownMark } from "./shell.js";

export type Location =
  | { readonly known: true; readonly root: string; readonly parts: readonly string[]; readonly caseless: boolean }
  | { readonly known: false; readonly text: string };

const sessionRoots = new Set(["env:", "variable:", "function:", "alias:"]);

const devices = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty", "/dev/zero", "nul", "nul:"]);

interface Rooted {
  readonly root: string;
  readonly rest: string;
  readonly caseless: boolean;
}

function rootOf(text: string): Rooted | undefined {
  const unc = /^[\\/]{2}([^\\/]+)[\\/]+([^\\/]+)(.*)$/.exec(text);
  if (unc !== null) {
    return { root: `//${unc[1] ?? ""}/${unc[2] ?? ""}`.toLowerCase(), rest: unc[3] ?? "", caseless: true };
  }
  const drive = /^([A-Za-z][A-Za-z0-9]*):(.*)$/.exec(text);
  if (drive !== null && (drive[1]?.length === 1 || sessionRoots.has(`${drive[1]?.toLowerCase() ?? ""}:`) || drive[1]?.toLowerCase() === "cert" || /^[\\/]/.test(drive[2] ?? ""))) {
    return { root: `${drive[1] ?? ""}:`.toLowerCase(), rest: drive[2] ?? "", caseless: true };
  }
  if (/^[\\/]/.test(text)) {
    return { root: "/", rest: text, caseless: false };
  }
  const home = /^(~[^\\/]*)(.*)$/.exec(text);
  if (home !== null) {
    return { root: home[1] ?? "~", rest: home[2] ?? "", caseless: false };
  }
  return undefined;
}

function walk(base: readonly string[], rest: string): string[] | undefined {
  const parts = [...base];
  for (const part of rest.split(/[\\/]+/)) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      parts.pop();
      continue;
    }
    if (/^\.[*?[]/.test(part)) {
      return undefined;
    }
    parts.push(part);
  }
  return parts;
}

export function locate(text: string, cwd: Location | undefined): Location {
  if (text.includes(unknownMark) || text === "") {
    return { known: false, text };
  }
  const rooted = rootOf(text);
  if (rooted !== undefined) {
    const parts = walk([], rooted.rest);
    return parts === undefined ? { known: false, text } : { known: true, root: rooted.root, parts, caseless: rooted.caseless };
  }
  if (cwd === undefined || !cwd.known) {
    return { known: false, text };
  }
  const parts = walk(cwd.parts, text);
  return parts === undefined ? { known: false, text } : { known: true, root: cwd.root, parts, caseless: cwd.caseless };
}

export function absolute(text: string): Location | undefined {
  const location = locate(text, undefined);
  return location.known ? location : undefined;
}

export function isAbsolutePath(text: string): boolean {
  return absolute(text) !== undefined;
}

export function join(location: Location, name: string): Location {
  if (!location.known) {
    return { known: false, text: `${location.text}/${name}` };
  }
  return locate(name, location);
}

export function parent(location: Location): Location {
  if (!location.known) {
    return { known: false, text: location.text.replace(/[\\/][^\\/]*$/, "") };
  }
  return { ...location, parts: location.parts.slice(0, -1) };
}

export function baseName(text: string): string {
  const parts = text.split(/[\\/]+/).filter((part) => part !== "");
  return parts[parts.length - 1] ?? text;
}

export function pathText(location: Location): string {
  if (!location.known) {
    return location.text.replaceAll("\\", "/");
  }
  const head = location.root === "/" ? "" : location.root;
  return `${head}/${location.parts.join("/")}`;
}

export function isDevice(location: Location): boolean {
  const text = pathText(location).toLowerCase();
  return devices.has(text) || text.startsWith("/dev/fd/") || location.known === false && devices.has(location.text.toLowerCase());
}

export function isSessionItem(location: Location): boolean {
  return location.known && sessionRoots.has(location.root);
}

function same(a: string, b: string, caseless: boolean): boolean {
  return caseless ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function within(location: Location, folder: Location, strictly: boolean): boolean {
  if (!location.known || !folder.known || !same(location.root, folder.root, folder.caseless)) {
    return false;
  }
  if (location.parts.length < folder.parts.length || (strictly && location.parts.length === folder.parts.length)) {
    return false;
  }
  return folder.parts.every((part, index) => same(location.parts[index] ?? "", part, folder.caseless));
}

function globSource(pattern: string): string {
  let source = "";
  let index = 0;
  while (index < pattern.length) {
    if (pattern.startsWith("**/", index)) {
      source += "(?:.*/)?";
      index += 3;
      continue;
    }
    if (pattern.startsWith("/**", index) && index + 3 === pattern.length) {
      source += "(?:/.*)?";
      index += 3;
      continue;
    }
    if (pattern.startsWith("**", index)) {
      source += ".*";
      index += 2;
      continue;
    }
    const char = pattern[index] ?? "";
    if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
    index += 1;
  }
  return source;
}

export type PathMatcher = (location: Location) => boolean;

export function globMatcher(patterns: readonly string[]): PathMatcher {
  const include: RegExp[] = [];
  const exclude: RegExp[] = [];
  for (const raw of patterns) {
    const pattern = raw.trim().replaceAll("\\", "/").toLowerCase();
    if (pattern === "" || pattern === "!") {
      continue;
    }
    if (pattern.startsWith("!")) {
      exclude.push(new RegExp(`^${globSource(pattern.slice(1))}$`));
    } else {
      include.push(new RegExp(`^${globSource(pattern)}$`));
    }
  }
  return (location) => {
    const text = pathText(location).toLowerCase();
    return include.some((pattern) => pattern.test(text)) && !exclude.some((pattern) => pattern.test(text));
  };
}
