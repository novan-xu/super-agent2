import { text as t } from "@super-agent2/catalog";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { z } from "zod";
import { Attachment, AttachmentUpload, Refusal } from "@super-agent2/protocol";
import { useAttachments, AttachButton, PendingList, SentAttachments } from "../parts/Attachments.js";
import type { Answer } from "../hub/api.js";
import { FileViewer, type ViewFile } from "../parts/FileViewer.js";
import { Icon } from "../parts/icons.js";
import { sizeOf } from "../live/size.js";
import type { UploadApi } from "../live/upload.js";

const itemSchema = z.object({ seq: z.number(), text: z.string(), device: z.enum(["phone", "desktop"]), at: z.number(), title: z.string().optional(), files: z.array(Attachment) });
type Item = z.infer<typeof itemSchema>;
const pageSchema = z.object({ items: z.array(itemSchema), more: z.boolean() });
const filePath = (id: string) => `/api/transfer/files/${encodeURIComponent(id)}`;
async function uploadRequest(path: string, init?: RequestInit): Promise<Answer<AttachmentUpload>> {
  try {
    const response = await fetch(path, init);
    const value: unknown = await response.json();
    const parsed = AttachmentUpload.safeParse(value);
    if (response.ok && parsed.success) return { ok: true, value: parsed.data };
    const refusal = Refusal.safeParse(value);
    return { ok: false, error: refusal.success ? refusal.data.error : "network" };
  } catch { return { ok: false, error: "network" }; }
}
const uploadApi: UploadApi = {
  createAttachment: (name, size, mediaType) => uploadRequest("/api/transfer/files", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, size, mediaType }) }),
  uploadState: (id) => uploadRequest(`${filePath(id)}/upload`),
  uploadPart: (id, offset, part) => uploadRequest(`${filePath(id)}/upload?offset=${offset}`, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: part }),
};

export function linked(text: string): ReactNode[] {
  return text.split(/(https?:\/\/[^\s<>"']+)/gu).map((part, index) => {
    if (!/^https?:\/\//u.test(part)) return part;
    const match = /^(.*?)([.,!?;:，。！？；：）)\]]*)$/u.exec(part);
    const url = match?.[1] ?? part;
    return <span key={index}><a href={url} target="_blank" rel="noopener noreferrer">{url}</a>{match?.[2]}</span>;
  });
}


export function RecentFiles({ items, open }: { readonly items: readonly Item[]; readonly open: (file: Attachment) => void }) {
  const files = [...items].sort((a, b) => b.seq - a.seq).flatMap(item => item.files.map(file => ({ file, item }))).slice(0, 50);
  return <ul className="conv-list">{files.map(({ file, item }) => <li key={file.id}>
    <a className="rail-item" href={filePath(file.id)} onClick={event => { event.preventDefault(); open(file); }}>
      <span className="ri-title od-truncate">{file.name}</span>
      <span className="ri-meta"><span>{sizeOf(file.size)}</span><time dateTime={new Date(item.at).toISOString()}>{new Date(item.at).toLocaleString()}</time><span>{item.title ?? (item.device === "phone" ? t("transfer.phone") : t("transfer.desktop"))}</span></span>
    </a>
  </li>)}</ul>;
}

export function TransferView({ navigation }: { readonly navigation: ReactNode }) {
  const [items, setItems] = useState<Item[]>([]);
  const [more, setMore] = useState(false);
  const [draft, setDraft] = useState(() => { try { return localStorage.getItem("transfer.draft") ?? ""; } catch { return ""; } });
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLDialogElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const older = useRef<{ height: number; top: number } | null>(null);
  const [viewFile, setViewFile] = useState<ViewFile | null>(null);
  const closeViewer = useCallback(() => setViewFile(null), []);
  const openFile = (file: Attachment) => {
    picker.current?.close();
    history.pushState({ ...history.state, fileViewer: true }, "");
    setViewFile({ name: file.name, size: file.size, mime: file.mediaType, url: filePath(file.id) });
  };
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element === null) return;
    if (older.current !== null) {
      element.scrollTop = older.current.top + element.scrollHeight - older.current.height;
      older.current = null;
    } else if (following.current) element.scrollTop = element.scrollHeight;
  }, [items]);
  useLayoutEffect(() => {
    const element = field.current;
    if (element !== null) { element.style.height = "auto"; element.style.height = `${Math.min(element.scrollHeight + 2, 200)}px`; }
  }, [draft]);
  const attaching = useAttachments("transfer", uploadApi);
  const load = useCallback(async (before?: number) => {
    try {
      const response = await fetch(`/api/transfer${before === undefined ? "" : `?before=${before}`}`, { cache: "no-store" });
      const parsed = pageSchema.safeParse(await response.json());
      if (!response.ok || !parsed.success) throw new Error();
      setItems((previous) => before === undefined ? parsed.data.items : [...parsed.data.items, ...previous.filter((item) => item.seq >= before)]);
      setMore(parsed.data.more); setError("");
    } catch { setError(t("transfer.loadFailed")); }
  }, []);
  useEffect(() => { void load(); const refresh = () => { void load(); }; window.addEventListener("transfer.changed", refresh); return () => window.removeEventListener("transfer.changed", refresh); }, [load]);
  const send = async (event: FormEvent) => {
    event.preventDefault(); if (sending || (draft.length === 0 && attaching.items.length === 0)) return;
    setSending(true);
    try {
      const files = await attaching.settle();
      if (files === undefined) throw new Error();
      const response = await fetch("/api/transfer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: draft, files, device: matchMedia("(pointer: coarse)").matches ? "phone" : "desktop" }) });
      if (!response.ok) throw new Error();
      setDraft(""); try { localStorage.removeItem("transfer.draft"); } catch {}
      attaching.clear(); following.current = true; await load();
    } catch { setError(t("transfer.sendFailed")); }
    finally { setSending(false); }
  };
  const remove = async (seq: number) => {
    if (!window.confirm(t("transfer.deleteConfirm"))) return;
    try { const response = await fetch(`/api/transfer/${seq}`, { method: "DELETE" }); if (!response.ok) throw new Error(); await load(); } catch { setError(t("transfer.deleteFailed")); }
  };
  return <div className="conv"><div className="conv-main"><div className="conv-bar">{navigation}
    <div className="conv-toolbar"><button className="conv-pick" type="button" aria-haspopup="dialog" onClick={() => picker.current?.showModal()}>{t("transfer.recentFiles")}<Icon name="down" size={16} /></button></div>
  </div>
    <div className="stream" ref={scroller} onScroll={event => { const el = event.currentTarget; following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48; }}>
      <div className="stream-inner" role="log" aria-label={t("conversation.transfer")}>
      {more && items[0] !== undefined ? <button className="btn btn-sm stream-older" type="button" onClick={() => { const el = scroller.current; if (el !== null) { following.current = false; older.current = { height: el.scrollHeight, top: el.scrollTop }; } void load(items[0]?.seq); }}>{t("transfer.older")}</button> : null}
      {items.length === 0 ? <p className="rail-empty">{t("transfer.empty")}</p> : items.map((item) => <article className="msg msg--me" key={item.seq}>
        <div className="msg-who"><time dateTime={new Date(item.at).toISOString()}>{new Date(item.at).toLocaleString()}</time>{item.title === undefined ? <span>{item.device === "phone" ? t("transfer.phone") : t("transfer.desktop")}</span> : <strong>{item.title}</strong>}
          {item.text !== "" ? <button className="btn btn-sm" type="button" onClick={() => void navigator.clipboard.writeText(item.text).catch(() => setError(t("transfer.copyFailed")))}>{t("transfer.copy")}</button> : null}
          <button className="btn btn-sm" type="button" onClick={() => void remove(item.seq)}>{t("transfer.delete")}</button>
        </div>
        {item.text !== "" ? <div className="msg-text msg-plain">{linked(item.text)}</div> : null}
        <SentAttachments attachments={item.files} path={filePath} />
      </article>)}
      </div>
    </div>
    <div className="composer-wrap"><form className="composer" onSubmit={(event) => void send(event)} onDragOver={attaching.over} onDrop={attaching.drop}>
      {error ? <p role="alert">{error}</p> : null}<PendingList attaching={attaching} />
      <textarea ref={field} rows={1} aria-label={t("transfer.content")} value={draft} onPaste={attaching.paste} onChange={(event) => { setDraft(event.target.value); try { localStorage.setItem("transfer.draft", event.target.value); } catch {} }} />
      <div className="composer-foot"><AttachButton add={attaching.add} /><span className="od-fill" /><button className="btn btn-primary btn-sm" type="submit" disabled={sending}><Icon name="send" />{t("transfer.send")}</button></div>
    </form></div>
  </div>
  <aside className="rail" aria-label={t("transfer.recentFiles")}><RecentFiles items={items} open={openFile} /></aside>
  <dialog className="dlg" ref={picker} aria-label={t("transfer.recentFiles")}><div className="dlg-in"><div className="dlg-head"><h2>{t("transfer.recentFiles")}</h2><button className="icon-btn" type="button" aria-label={t("conversation.close")} onClick={() => picker.current?.close()}><Icon name="x" /></button></div><RecentFiles items={items} open={openFile} /></div></dialog>
  {viewFile === null ? null : <FileViewer files={[viewFile]} index={0} close={closeViewer} />}
  </div>;
}
