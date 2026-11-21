import { text } from "@super-agent2/catalog";
import { useEffect, useRef, useState } from "react";
import { sizeOf } from "../live/size.js";
import { canDrawBytes, decodeText, delimiterOf, kindOf, parseTable, svgImage, type FileKind } from "./filekind.js";
import { Markdown } from "./Markdown.js";
import { showPdf } from "./pdf.js";

export interface ViewFile { name: string; size: number; mime: string; url: string }

function PdfView({ url, fail }: { url: string; fail: () => void }) {
  useEffect(() => {
    const host = document.getElementById("file-viewer-pdf");
    let active = true;
    let stop: (() => void) | undefined;
    if (host) void showPdf(host, url, () => active).then(release => { if (active) stop = release; else release(); }).catch(() => { if (active) fail(); });
    return () => { active = false; stop?.(); };
  }, [url, fail]);
  return <div id="file-viewer-pdf" className="fv-pdf-host" />;
}

function Content({ file, kind, source }: { file: ViewFile; kind: FileKind; source: boolean }) {
  const [data, setData] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [reason, setReason] = useState("");
  const [officeReady, setOfficeReady] = useState(false);
  useEffect(() => {
    if (kind !== "office") return;
    const abort = new AbortController();
    void fetch(`${file.url}/preview`, { signal: abort.signal }).then(async response => { if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(typeof body.message === "string" ? body.message : "Conversion failed."); } await response.body?.cancel(); setOfficeReady(true); }).catch(error => { if (!abort.signal.aborted) { setReason(error instanceof Error ? error.message : "Conversion failed."); setFailed(true); } });
    return () => abort.abort();
  }, [file.url, kind]);
  const [actual, setActual] = useState(false);
  useEffect(() => {
    if (!["vector", "markdown", "text", "table", "html"].includes(kind)) return;
    if (!canDrawBytes(file.size)) { setFailed(true); return; }
    const abort = new AbortController();
    let objectUrl: string | undefined;
    void fetch(file.url, { signal: abort.signal }).then(async response => {
      if (!response.ok) throw new Error("Read failed");
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!canDrawBytes(bytes.length)) throw new Error("Too large");
      if (kind === "vector") { objectUrl = URL.createObjectURL(svgImage(bytes)); setData(objectUrl); }
      else setData(decodeText(bytes));
    }).catch(() => { if (!abort.signal.aborted) setFailed(true); });
    return () => { abort.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [file, kind]);
  const fail = useState(() => () => setFailed(true))[0];
  if (failed || kind === "other") return <div className="fv-fallback"><strong>{file.name}</strong><span>{sizeOf(file.size)}</span>{failed ? <span>{reason || text("viewer.failed")}</span> : null}<a href={file.url} download={file.name}>{text("viewer.download")}</a></div>;
  if (kind === "image" || kind === "vector") return kind === "vector" && data === null ? null : <img className={actual ? "fv-image actual" : "fv-image"} src={kind === "vector" ? data ?? undefined : file.url} alt={file.name} onClick={() => setActual(!actual)} onError={fail} />;
  if (kind === "video") return <video controls playsInline src={file.url} onError={fail} />;
  if (kind === "audio") return <audio controls src={file.url} onError={fail} />;
  if (kind === "office" && !officeReady) return null;
  if (kind === "pdf" || kind === "office") return <PdfView url={kind === "office" ? `${file.url}/preview` : file.url} fail={fail} />;
  if (data === null) return null;
  if (kind === "html" && !source) return <iframe className="fv-html" title={file.name} sandbox="" src={`${file.url}/render`} />;
  if (kind === "markdown") return <article className="fv-document"><Markdown text={data} /></article>;
  if (kind === "table") { const table = parseTable(data, delimiterOf(data, file.name)); return <div className="fv-table"><table><tbody>{table.rows.map((row, i) => <tr key={i}>{row.map((cell, j) => i === 0 ? <th key={j}>{cell}</th> : <td key={j}>{cell}</td>)}</tr>)}</tbody></table>{table.total > table.rows.length ? <p>{table.rows.length} / {table.total}</p> : null}</div>; }
  return <pre className="fv-text">{data}</pre>;
}

export function FileViewer({ files, index, close }: { files: readonly ViewFile[]; index: number; close: () => void }) {
  const [selected, setSelected] = useState(index);
  const layer = useRef<HTMLDivElement>(null);
  const file = files[selected]!;
  const [mime, setMime] = useState(file.mime);
  const [source, setSource] = useState(false);
  useEffect(() => {
    setMime(file.mime);
    setSource(false);
    if (file.mime) return;
    const abort = new AbortController();
    void fetch(file.url, { method: "HEAD", signal: abort.signal }).then(response => { setMime(response.ok ? response.headers.get("x-file-media-type") ?? "application/octet-stream" : "application/octet-stream"); }).catch(() => { if (!abort.signal.aborted) setMime("application/octet-stream"); });
    return () => abort.abort();
  }, [file]);
  const kind = kindOf({ name: file.name, mime });
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    layer.current?.focus();
    const pop = () => close();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); history.back(); }
      if (event.key === "Tab" && layer.current) {
        const stops = Array.from(layer.current.querySelectorAll<HTMLElement>("a[href], button, video, audio"));
        if (stops.length === 0) return;
        event.preventDefault();
        const at = stops.indexOf(document.activeElement as HTMLElement);
        stops[(at + (event.shiftKey ? -1 : 1) + stops.length) % stops.length]?.focus();
      }
    };
    window.addEventListener("popstate", pop);
    window.addEventListener("keydown", key);
    return () => { window.removeEventListener("popstate", pop); window.removeEventListener("keydown", key); previous?.focus(); };
  }, [close]);
  return <div className="fv" ref={layer} tabIndex={-1} role="dialog" aria-modal="true" aria-label={file.name}>
    <header className="fv-header"><strong>{file.name}</strong><span>{selected + 1} / {files.length}</span>{kind === "html" ? <button className="fv-toggle" onClick={() => setSource(!source)}>{text(source ? "viewer.rendered" : "viewer.source")}</button> : null}<a href={file.url} download={file.name}>{text("viewer.download")}</a><button onClick={() => history.back()} aria-label={text("viewer.close")}>×</button></header>
    <div className="fv-body">{!mime && kind === "other" ? null : <Content key={file.url} file={file} kind={kind} source={source} />}</div>
    {selected > 0 ? <button className="fv-prev" onClick={() => setSelected(selected - 1)} aria-label={text("viewer.previous")}>‹</button> : null}
    {selected < files.length - 1 ? <button className="fv-next" onClick={() => setSelected(selected + 1)} aria-label={text("viewer.next")}>›</button> : null}
  </div>;
}
