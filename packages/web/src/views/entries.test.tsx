import type { ConversationEntry } from "@super-agent2/protocol";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { sizeOf } from "../live/size.js";
import { streamItems } from "../live/stream.js";
import { StreamEntry } from "./Entries.js";

const id = "c1";
const at = new Date(2026, 10, 17, 9, 30).getTime();

const delivery: ConversationEntry = {
  id: "d1",
  conversation: id,
  seq: 2,
  at,
  kind: "delivery",
  turn: null,
  ticket: 4,
  title: { en: "Translate a notice", zh: "翻译一则通知" },
  text: "Hello, <b>world</b>.\n\nSecond paragraph.",
  files: [
    { name: "译文 1.pdf", size: 4_300_000 },
    { name: "notes.txt", size: 12 },
  ],
};

describe("a delivery in the conversation", () => {
  it("shows the text as written, the Chinese title, and each file as a download of its own ticket", () => {
    const items = streamItems(
      { id, conversation: undefined, turns: [], entries: [{ id: "o1", conversation: id, seq: 1, at, kind: "owner", text: "翻译一下", attachments: [], taken: true }, delivery] },
      at,
    );
    const item = items.find((entry) => entry.kind === "entry" && entry.entry.kind === "delivery");
    expect(item).toMatchObject({ kind: "entry", lead: false, live: false });
    if (item === undefined) {
      throw new Error("no delivery item");
    }
    const html = renderToString(<StreamEntry item={item} thisYear={2026} />);
    expect(html).toContain("翻译一则通知");
    expect(html).toContain("Hello, &lt;b&gt;world&lt;/b&gt;.");
    expect(html).not.toContain("<b>world</b>");
    expect(html).toContain('class="msg-text msg-plain delivery-text"');
    expect(html).toContain('href="/api/tickets/4/files/%E8%AF%91%E6%96%87%201.pdf"');
    expect(html).toContain('download="译文 1.pdf"');
    expect(html).toContain("4.1 MB");
    expect(html).toContain('href="/api/tickets/4/files/notes.txt"');
  });

  it("shows only the files when there is no text", () => {
    const html = renderToString(
      <StreamEntry item={{ kind: "entry", key: "d2", entry: { ...delivery, text: null, files: [{ name: "a.docx", size: 2048 }] }, lead: false, live: false }} thisYear={2026} />,
    );
    expect(html).not.toContain("delivery-text");
    expect(html).toContain("2 KB");
  });

  it("writes sizes in the nearest unit", () => {
    expect([0, 12, 1024, 1536, 10_240, 4_300_000, 3_221_225_472].map(sizeOf)).toEqual(["0 B", "12 B", "1 KB", "1.5 KB", "10 KB", "4.1 MB", "3 GB"]);
  });
});

describe("the owner's attachments in the conversation", () => {
  it("show an image as a picture and any other file by name and size, each a download, with no empty text", () => {
    const photo = { id: "a".repeat(32), name: "照片.jpg", size: 2_000_000, mediaType: "image/jpeg" };
    const sheet = { id: "b".repeat(32), name: "budget.xlsx", size: 2_048, mediaType: "application/vnd.ms-excel" };
    const items = streamItems({ id, conversation: undefined, turns: [], entries: [{ id: "o1", conversation: id, seq: 1, at, kind: "owner", text: "", attachments: [photo, sheet], taken: true }] }, at);
    const html = items.map((item) => renderToString(<StreamEntry item={item} thisYear={2026} />)).join("");
    expect(html).toContain(`<img src="/api/attachments/${photo.id}" alt="照片.jpg"`);
    expect(html).toContain(`href="/api/attachments/${sheet.id}" download="budget.xlsx"`);
    expect(html).toContain(sizeOf(2_048));
    expect(html).not.toContain("msg-text");
  });
});
