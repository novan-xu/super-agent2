

export type FileKind = 'image' | 'vector' | 'video' | 'audio' | 'pdf' | 'office' | 'markdown' | 'table' | 'text' | 'other'

const KINDS: [FileKind, string][] = [
  ['image', 'png jpg jpeg gif webp avif bmp'],
  ['vector', 'svg'],
  ['video', 'mp4 m4v webm mov ogv'],
  ['audio', 'mp3 m4a aac wav ogg oga opus flac weba'],
  ['pdf', 'pdf'],
  ['office', 'doc docx docm dot dotx dotm rtf odt ott xls xlsx xlsm xlsb xlt xltx xltm ods ots ppt pptx pptm pps ppsx ppsm pot potx potm odp otp'],
  ['markdown', 'md markdown'],
  ['table', 'csv tsv'],
  ['text', 'txt text log json jsonl ndjson xml yaml yml toml ini conf cfg env properties sh bash zsh bat cmd ps1 py js mjs cjs ts mts cts tsx jsx css scss less '
    + 'html htm vue svelte c h cc cpp hpp cs java kt kts go rs rb php swift m mm sql tex bib srt vtt diff patch gitignore dockerfile makefile lua r pl gradle'],
]
const BY_EXTENSION = new Map(KINDS.flatMap(([kind, names]) => names.split(' ').map(name => [name, kind] as const)))
const BY_TYPE: [RegExp, FileKind][] = [
  [/^image\/(png|jpeg|gif|webp|avif|bmp)$/, 'image'], [/^image\/svg\+xml$/, 'vector'], [/^video\//, 'video'], [/^audio\//, 'audio'],
  [/^application\/pdf$/, 'pdf'], [/^text\/(markdown|x-markdown)$/, 'markdown'], [/^text\/(csv|tab-separated-values)$/, 'table'],
  [/^text\//, 'text'], [/^application\/(json|xml|x-yaml|yaml|toml|javascript|x-sh|sql)$/, 'text'],
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

export const TABLE_ROWS = 2000

export function delimiterOf(text: string, name = ''): string {
  if (extensionOf(name) === 'tsv') return '\t'
  const first = text.slice(0, text.search(/\r?\n/) === -1 ? text.length : text.search(/\r?\n/))
  const count = (mark: string) => first.split(mark).length - 1
  return [',', ';', '\t'].reduce((best, mark) => count(mark) > count(best) ? mark : best)
}

export function parseTable(text: string, delimiter = ',', limit = TABLE_ROWS): { rows: string[][]; total: number } {
  const rows: string[][] = []
  let row: string[] = [], cell = '', quoted = false, total = 0
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const endRow = () => {
    row.push(cell); cell = ''
    if (row.length > 1 || row[0] !== '') { total++; if (rows.length < limit) rows.push(row) }
    row = []
  }
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!
    if (quoted) {
      if (char !== '"') cell += char
      else if (source[i + 1] === '"') { cell += '"'; i++ }
      else quoted = false
    } else if (char === '"' && cell === '') quoted = true
    else if (char === delimiter) { row.push(cell); cell = '' }
    else if (char === '\n') endRow()
    else if (char !== '\r' || source[i + 1] !== '\n') cell += char
  }
  if (cell !== '' || row.length) endRow()
  return { rows, total }
}

export function canDrawBytes(size: number): boolean {
  return size <= TEXT_BYTES;
}

export function svgImage(bytes: Uint8Array<ArrayBuffer>): Blob {
  return new Blob([bytes], { type: "image/svg+xml" });
}
