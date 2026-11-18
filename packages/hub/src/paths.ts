import { unknownMark } from "./shell.js";

export type Location =
  | { readonly known: true; readonly root: string; readonly parts: readonly string[]; readonly caseless: boolean }
  | { readonly known: false; readonly text: string };

const sessionRoots = new Set(["env:", "variable:", "function:", "alias:"]);

interface Rooted {
  readonly root: string;
  readonly rest: string;
  readonly caseless: boolean;
}

const markedVariable = /^\u0000\u0002([^\u0003]+)\u0003(.*)$/s;

const windowsVariable = /^%([A-Za-z_][A-Za-z0-9_]*)%(.*)$/s;

export function variableRoot(name: string): string {
  const environment = /^env:(.+)$/i.exec(name);
  return environment === null ? `$${name}` : `$${(environment[1] ?? "").toUpperCase()}`;
}

function variableOf(text: string): Rooted | undefined {
  const marked = markedVariable.exec(text);
  const windows = marked === null ? windowsVariable.exec(text) : null;
  const found = marked ?? windows;
  if (found === null) {
    return undefined;
  }
  const rest = found[2] ?? "";
  if (rest !== "" && !/^[\\/]/.test(rest)) {
    return undefined;
  }
  const name = found[1] ?? "";
  const root = windows === null ? variableRoot(name) : `$${name.toUpperCase()}`;
  return { root, rest, caseless: windows !== null || /^env:/i.test(name) };
}

function climbable(root: string): boolean {
  return !root.startsWith("$") && !root.startsWith("~");
}

function rootOf(text: string): Rooted | undefined {
  const variable = variableOf(text);
  if (variable !== undefined) {
    return variable;
  }
  const unc = /^[\\/]{2}([^\\/]+)[\\/]+([^\\/]+)(.*)$/.exec(text);
  if (unc !== null) {
    return { root: `//${unc[1] ?? ""}/${unc[2] ?? ""}`.toLowerCase(), rest: unc[3] ?? "", caseless: true };
  }
  const drive = /^([A-Za-z][A-Za-z0-9]*):(.*)$/.exec(text);
  if (drive !== null && (drive[1]?.length === 1 || sessionRoots.has(`${drive[1]?.toLowerCase() ?? ""}:`) || /^[\\/]/.test(drive[2] ?? ""))) {
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

function walk(base: readonly string[], rest: string, floor: boolean): string[] | undefined {
  const parts = [...base];
  for (const part of rest.split(/[\\/]+/)) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      if (floor && parts.length === 0) {
        return undefined;
      }
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
  if (text === "") {
    return { known: false, text };
  }
  const rooted = rootOf(text);
  if (rooted !== undefined) {
    const parts = rooted.rest.includes(unknownMark) ? undefined : walk([], rooted.rest, !climbable(rooted.root));
    return parts === undefined ? { known: false, text } : { known: true, root: rooted.root, parts, caseless: rooted.caseless };
  }
  if (text.includes(unknownMark) || cwd === undefined || !cwd.known) {
    return { known: false, text };
  }
  const parts = walk(cwd.parts, text, !climbable(cwd.root));
  return parts === undefined ? { known: false, text } : { known: true, root: cwd.root, parts, caseless: cwd.caseless };
}

export function absolute(text: string): Location | undefined {
  const location = locate(text, undefined);
  return location.known ? location : undefined;
}

export function isAbsolutePath(text: string): boolean {
  return absolute(text) !== undefined;
}

export function pathText(location: Location): string {
  if (!location.known) {
    return location.text.replaceAll("\\", "/");
  }
  const head = location.root === "/" ? "" : location.root;
  return `${head}/${location.parts.join("/")}`;
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
