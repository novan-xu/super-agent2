export { canDrawBytes, decodeText, extensionOf, kindOf, TEXT_BYTES, type FileKind } from "@super-agent2/catalog";
import { extensionOf } from "@super-agent2/catalog";

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

export function svgImage(bytes: Uint8Array<ArrayBuffer>): Blob {
  return new Blob([bytes], { type: "image/svg+xml" });
}
