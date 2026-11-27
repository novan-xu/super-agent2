import { appPath } from "./app-path.js";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type * as Pdf from "pdfjs-dist";

let library: Promise<typeof Pdf> | undefined;
function pdfLib(): Promise<typeof Pdf> {
  library ??= import("pdfjs-dist").then(lib => { lib.GlobalWorkerOptions.workerSrc = workerUrl; return lib; });
  return library;
}

const KEPT_PAGES = 12
const PAGE_PIXELS = 16_000_000

export async function showPdf(host: HTMLElement, url: string, current: () => boolean = () => true): Promise<() => void> {
  const lib = await pdfLib()
  const task = lib.getDocument({ url, withCredentials: true, useWasm: false, enableXfa: false, cMapUrl: appPath("/pdfjs/cmaps/"), cMapPacked: true, standardFontDataUrl: appPath("/pdfjs/standard_fonts/") })
  let stopped = false
  const stop = () => { stopped = true; observer?.disconnect(); void task.destroy().catch(() => {}) }
  let observer: IntersectionObserver | undefined
  let pdf: Pdf.PDFDocumentProxy, first: { width: number; height: number }
  try {
    pdf = await task.promise
    first = (await pdf.getPage(1)).getViewport({ scale: 1 })
  } catch (error) { stop(); throw error }
  if (!current()) { stop(); return stop }
  const drawn: HTMLElement[] = []
  const draw = async (holder: HTMLElement) => {
    if (stopped || holder.dataset.state) return
    holder.dataset.state = 'drawing'
    try {
      const page = await pdf.getPage(Number(holder.dataset.page))
      const natural = page.getViewport({ scale: 1 })
      holder.style.aspectRatio = `${natural.width} / ${natural.height}`
      const width = holder.clientWidth || natural.width
      let scale = width / natural.width * Math.min(devicePixelRatio || 1, 2)
      if (natural.width * natural.height * scale * scale > PAGE_PIXELS) scale = Math.sqrt(PAGE_PIXELS / (natural.width * natural.height))
      const viewport = page.getViewport({ scale })
      const canvas = document.createElement('canvas')
      canvas.width = Math.floor(viewport.width)
      canvas.height = Math.floor(viewport.height)
      await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport }).promise
      if (stopped) return
      holder.replaceChildren(canvas)
      holder.dataset.state = 'drawn'
      drawn.push(holder)
      while (drawn.length > KEPT_PAGES) {
        const old = drawn.find(item => item !== holder && item.dataset.near !== 'true')
        if (!old) break
        drawn.splice(drawn.indexOf(old), 1)
        old.replaceChildren()
        delete old.dataset.state
      }
    } catch {
      if (!stopped) delete holder.dataset.state
    }
  }
  observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const holder = entry.target as HTMLElement
      holder.dataset.near = String(entry.isIntersecting)
      if (entry.isIntersecting) void draw(holder)
    }
  }, { root: host.closest('.fv-body'), rootMargin: '100% 0px' })
  const pages = document.createElement('div')
  pages.className = 'fv-pdf'
  for (let number = 1; number <= pdf.numPages; number++) {
    const holder = document.createElement('div')
    holder.className = 'fv-page'
    holder.dataset.page = String(number)
    holder.style.aspectRatio = `${first.width} / ${first.height}`
    holder.style.maxWidth = `${Math.round(first.width * 1.6)}px`
    pages.append(holder)
    observer.observe(holder)
  }
  if (stopped || !current()) { stop(); return stop }
  host.replaceChildren(pages)
  return stop
}
