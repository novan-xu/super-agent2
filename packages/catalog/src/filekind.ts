

export type FileKind = 'image' | 'vector' | 'video' | 'audio' | 'pdf' | 'office' | 'markdown' | 'table' | 'html' | 'text' | 'other'

const KINDS: [FileKind, string][] = [
  ['image', 'png jpg jpeg gif webp avif bmp'],
  ['vector', 'svg'],
  ['video', 'mp4 m4v webm mov ogv'],
  ['audio', 'mp3 m4a aac wav ogg oga opus flac weba'],
  ['pdf', 'pdf'],
  ['office', 'doc docx docm dot dotx dotm rtf odt ott xls xlsx xlsm xlsb xlt xltx xltm ods ots ppt pptx pptm pps ppsx ppsm pot potx potm odp otp'],
  ['markdown', 'md markdown'],
  ['table', 'csv tsv'],
  ['html', 'html htm'],
  ['text', 'txt text log json jsonl ndjson xml yaml yml toml ini conf cfg env properties sh bash zsh bat cmd ps1 py js mjs cjs ts mts cts tsx jsx css scss less '
    + 'vue svelte c h cc cpp hpp cs java kt kts go rs rb php swift m mm sql tex bib srt vtt diff patch gitignore dockerfile makefile lua r pl gradle'],
]
const BY_EXTENSION = new Map(KINDS.flatMap(([kind, names]) => names.split(' ').map(name => [name, kind] as const)))
const BY_TYPE: [RegExp, FileKind][] = [
  [/^image\/(png|jpeg|gif|webp|avif|bmp)$/, 'image'], [/^image\/svg\+xml$/, 'vector'], [/^video\//, 'video'], [/^audio\//, 'audio'],
  [/^application\/pdf$/, 'pdf'], [/^text\/(markdown|x-markdown)$/, 'markdown'], [/^text\/(csv|tab-separated-values)$/, 'table'],
  [/^text\/html(?:\s*;|$)/i, 'html'], [/^text\//, 'text'], [/^application\/(json|xml|x-yaml|yaml|toml|javascript|x-sh|sql)$/, 'text'],
]

export function extensionOf(name: string): string {
  const base = name.toLowerCase().split(/[\\/]/).at(-1) ?? ''
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1) : base.replace(/^\./, '')
}

export function kindOf(file: { name: string; mime: string }): FileKind {
  const named = BY_EXTENSION.get(extensionOf(file.name))
  const byName = named === 'text' || /[^.]\.[^./\\]+$/.test(file.name) ? named : undefined
  return byName ?? BY_TYPE.find(([type]) => type.test(file.mime))?.[1] ?? 'other'
}

export const TEXT_BYTES = 5 * 1024 * 1024

export function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes)
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes)
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch {}
  try { return new TextDecoder('gb18030').decode(bytes) } catch { return new TextDecoder().decode(bytes) }
}

export function canDrawBytes(size: number): boolean {
  return size <= TEXT_BYTES;
}
