import { FileViewer } from "./FileViewer.js";
import { text } from "@super-agent2/catalog";
import { type Attachment, isNativeImage } from "@super-agent2/protocol";
import { type ClipboardEvent, type DragEvent, useCallback, useEffect, useRef, useState } from "react";
import { attachmentPath, hubApi } from "../hub/api.js";
import { sizeOf } from "../live/size.js";
import { nameOf, upload, type UploadApi } from "../live/upload.js";
import { Icon } from "./icons.js";

export type PendingState = "uploading" | "done" | "failed";

export interface Pending {
  readonly key: string;
  readonly file: File;
  readonly name: string;
  readonly preview: string | null;
  readonly id: string | null;
  readonly received: number;
  readonly state: PendingState;
}

export interface Attaching {
  readonly items: readonly Pending[];
  add(files: Iterable<File>): void;
  remove(key: string): void;
  retry(key: string): void;
  settle(): Promise<string[] | undefined>;
  clear(): void;
  readonly paste: (event: ClipboardEvent) => void;
  readonly drop: (event: DragEvent) => void;
  readonly over: (event: DragEvent) => void;
}

let counter = 0;

function previewOf(file: File): string | null {
  return isNativeImage(file.type) && typeof URL.createObjectURL === "function" ? URL.createObjectURL(file) : null;
}

function release(item: Pending): void {
  if (item.preview !== null && typeof URL.revokeObjectURL === "function") {
    URL.revokeObjectURL(item.preview);
  }
}

export function useAttachments(draft: string, api: UploadApi = hubApi): Attaching {
  const [all, setAll] = useState<Readonly<Record<string, readonly Pending[]>>>({});
  const current = useRef(all);
  current.current = all;
  const running = useRef(new Map<string, Promise<string | null>>());
  const items = all[draft] ?? [];

  const change = useCallback(
    (key: string, update: (item: Pending) => Pending) => {
      setAll((before) => {
        const next: Record<string, readonly Pending[]> = {};
        for (const [name, list] of Object.entries(before)) {
          next[name] = list.map((item) => (item.key === key ? update(item) : item));
        }
        return next;
      });
    },
    [],
  );

  const find = (key: string): Pending | undefined => Object.values(current.current).flat().find((item) => item.key === key);

  const start = useCallback(
    (item: Pending): Promise<string | null> => {
      const known = running.current.get(item.key);
      if (known !== undefined) {
        return known;
      }
      change(item.key, (value) => ({ ...value, state: "uploading" }));
      const task = upload(item.file, item.name, api, item.id, (id, received) => change(item.key, (value) => ({ ...value, id, received }))).then((outcome) => {
        running.current.delete(item.key);
        change(item.key, (value) => ({ ...value, id: outcome.id ?? value.id, state: outcome.ok ? "done" : "failed" }));
        return outcome.ok ? outcome.id : null;
      });
      running.current.set(item.key, task);
      return task;
    },
    [api, change],
  );

  const add = useCallback(
    (files: Iterable<File>) => {
      const now = Date.now();
      const added = [...files].map((file, index): Pending => {
        counter += 1;
        return { key: `a${counter}`, file, name: nameOf(file, index, now), preview: previewOf(file), id: null, received: 0, state: "uploading" };
      });
      if (added.length === 0) {
        return;
      }
      setAll((before) => ({ ...before, [draft]: [...(before[draft] ?? []), ...added] }));
      for (const item of added) {
        void start(item);
      }
    },
    [draft, start],
  );

  const remove = useCallback(
    (key: string) => {
      setAll((before) => {
        const list = before[draft] ?? [];
        list.filter((item) => item.key === key).forEach(release);
        return { ...before, [draft]: list.filter((item) => item.key !== key) };
      });
    },
    [draft],
  );

  const retry = useCallback(
    (key: string) => {
      const item = find(key);
      if (item !== undefined && item.state === "failed") {
        void start(item);
      }
    },
    [start],
  );

  const settle = useCallback(async (): Promise<string[] | undefined> => {
    const list = current.current[draft] ?? [];
    const ids = await Promise.all(list.map((item) => (item.state === "done" ? Promise.resolve(item.id) : start(item))));
    return ids.every((id): id is string => id !== null) ? ids : undefined;
  }, [draft, start]);

  const clear = useCallback(() => {
    setAll((before) => {
      (before[draft] ?? []).forEach(release);
      return { ...before, [draft]: [] };
    });
  }, [draft]);

  const paste = useCallback(
    (event: ClipboardEvent) => {
      const files = [...event.clipboardData.files];
      if (files.length > 0) {
        event.preventDefault();
        add(files);
      }
    },
    [add],
  );

  const over = useCallback((event: DragEvent) => {
    if ([...event.dataTransfer.types].includes("Files")) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    }
  }, []);

  const drop = useCallback(
    (event: DragEvent) => {
      if (event.dataTransfer.files.length > 0) {
        event.preventDefault();
        add([...event.dataTransfer.files]);
      }
    },
    [add],
  );

  useEffect(
    () => () => {
      Object.values(current.current).flat().forEach(release);
    },
    [],
  );

  return { items, add, remove, retry, settle, clear, paste, drop, over };
}

export function AttachButton({ add }: { readonly add: (files: Iterable<File>) => void }) {
  return (
    <label className="icon-btn" title={text("attach.add")}>
      <Icon name="clip" />
      <span className="sr-only">{text("attach.add")}</span>
      <input
        className="sr-only"
        type="file"
        multiple
        onChange={(event) => {
          const files = event.currentTarget.files;
          if (files !== null) {
            add([...files]);
          }
          event.currentTarget.value = "";
        }}
      />
    </label>
  );
}

export function PendingList({ attaching }: { readonly attaching: Attaching }) {
  if (attaching.items.length === 0) {
    return null;
  }
  return (
    <div className="att">
      {attaching.items.map((item) => {
        const share = item.file.size === 0 ? 1 : item.received / item.file.size;
        return (
          <span
            key={item.key}
            className={`chip att-item att-item--${item.state}`}
            style={{ "--att-progress": `${Math.round((item.state === "done" ? 1 : share) * 100)}%` } as Record<string, string>}
          >
            {item.preview === null ? <Icon name="clip" /> : <img className="att-thumb" src={item.preview} alt="" />}
            <span className="od-truncate att-name">{item.name}</span>
            {item.state === "failed" ? (
              <button type="button" aria-label={text("attach.retry", { name: item.name })} title={text("attach.retry", { name: item.name })} onClick={() => attaching.retry(item.key)}>
                <Icon name="alert" size={12} />
              </button>
            ) : null}
            <button type="button" aria-label={text("attach.remove", { name: item.name })} onClick={() => attaching.remove(item.key)}>
              <Icon name="x" size={12} />
            </button>
          </span>
        );
      })}
    </div>
  );
}

export function SentAttachments({ attachments }: { readonly attachments: readonly Attachment[] }) {
  const [selected, setSelected] = useState<number | null>(null);
  const close = useCallback(() => setSelected(null), []);
  if (attachments.length === 0) {
    return null;
  }
  const images = attachments.filter((attachment) => isNativeImage(attachment.mediaType));
  const files = attachments.filter((attachment) => !isNativeImage(attachment.mediaType));
  const ordered = [...images, ...files];
  const viewFiles = ordered.map(a => ({ name: a.name, size: a.size, mime: a.mediaType, url: attachmentPath(a.id) }));
  return (
    <div className="msg-files msg-attachments">
      {images.map((attachment) => (
        <a key={attachment.id} className="att-image" href={attachmentPath(attachment.id)} download={attachment.name} title={attachment.name} onClick={event => { event.preventDefault(); history.pushState({ ...history.state, fileViewer: true }, ""); setSelected(ordered.indexOf(attachment)); }}>
          <img src={attachmentPath(attachment.id)} alt={attachment.name} loading="lazy" />
        </a>
      ))}
      {files.map((attachment) => (
        <a key={attachment.id} className="chip" href={attachmentPath(attachment.id)} download={attachment.name} onClick={event => { event.preventDefault(); history.pushState({ ...history.state, fileViewer: true }, ""); setSelected(ordered.indexOf(attachment)); }}>
          <Icon name="clip" />
          <span className="od-truncate att-name">{attachment.name}</span>
          <span className="num">{sizeOf(attachment.size)}</span>
        </a>
      ))}
      {selected === null ? null : <FileViewer files={viewFiles} index={selected} close={close} />}
    </div>
  );
}
