import { text as t } from "@super-agent2/catalog";
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { z } from "zod";
import { Attachment, AttachmentUpload, Refusal } from "@super-agent2/protocol";
import { useAttachments, AttachButton, PendingList } from "../parts/Attachments.js";
import type { Answer } from "../hub/api.js";
import type { UploadApi } from "../live/upload.js";

const itemSchema = z.object({ seq: z.number(), text: z.string(), device: z.enum(["phone", "desktop"]), at: z.number(), files: z.array(Attachment) });
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

export function TransferView({ navigation }: { readonly navigation: ReactNode }) {
  const [items, setItems] = useState<Item[]>([]);
  const [more, setMore] = useState(false);
  const [draft, setDraft] = useState(() => { try { return localStorage.getItem("transfer.draft") ?? ""; } catch { return ""; } });
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
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
      attaching.clear(); await load();
    } catch { setError(t("transfer.sendFailed")); }
    finally { setSending(false); }
  };
  const remove = async (seq: number) => {
    if (!window.confirm(t("transfer.deleteConfirm"))) return;
    try { const response = await fetch(`/api/transfer/${seq}`, { method: "DELETE" }); if (!response.ok) throw new Error(); await load(); } catch { setError(t("transfer.deleteFailed")); }
  };
  return <div className="conv conv--solo"><div className="conv-main"><div className="conv-bar">{navigation}</div>
    <div className="transfer-list" aria-label={t("conversation.transfer")}>
      {more && items[0] !== undefined ? <button type="button" onClick={() => void load(items[0]?.seq)}>{t("transfer.older")}</button> : null}
      {items.length === 0 ? <p>{t("transfer.empty")}</p> : items.map((item) => <article className="transfer-entry" key={item.seq}>
        <div className="transfer-meta"><time dateTime={new Date(item.at).toISOString()}>{new Date(item.at).toLocaleString()}</time> · {item.device === "phone" ? t("transfer.phone") : t("transfer.desktop")}</div>
        {item.text !== "" ? <p className="transfer-text">{linked(item.text)}</p> : null}
        <div className="transfer-files">{item.files.map((file) => <a key={file.id} href={filePath(file.id)} download={file.name}>{file.name}</a>)}</div>
        <div>{item.text !== "" ? <button type="button" onClick={() => void navigator.clipboard.writeText(item.text).catch(() => setError(t("transfer.copyFailed")))}>{t("transfer.copy")}</button> : null} <button type="button" onClick={() => void remove(item.seq)}>{t("transfer.delete")}</button></div>
      </article>)}
    </div>
    <form className="transfer-compose" onSubmit={(event) => void send(event)} onDragOver={attaching.over} onDrop={attaching.drop}>
      {error ? <p role="alert">{error}</p> : null}<PendingList attaching={attaching} />
      <textarea aria-label={t("transfer.content")} value={draft} onPaste={attaching.paste} onChange={(event) => { setDraft(event.target.value); try { localStorage.setItem("transfer.draft", event.target.value); } catch {} }} />
      <div><AttachButton add={attaching.add} /><button type="submit" disabled={sending}>{t("transfer.send")}</button></div>
    </form>
  </div></div>;
}
