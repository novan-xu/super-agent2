import type { Memory, MemorySuggestion } from "@super-agent2/protocol";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { initialMemory, type MemoryState, receiveMemories } from "../live/memory.js";
import { MemoryView } from "./MemoryView.js";

const now = Date.UTC(2026, 10, 17, 12, 0, 0);

function memory(id: number, text: string, by: Memory["by"], changedAt: number): Memory {
  return { id, text, by, revision: id, createdAt: changedAt, changedAt };
}

function suggestion(id: number, text: string, more: Partial<MemorySuggestion> = {}): MemorySuggestion {
  return { id, kind: "remember", text, memory: null, replaces: [], createdAt: now - 1000, ...more };
}

const actions = { add: () => Promise.resolve(true), edit: () => Promise.resolve(true), remove: () => Promise.resolve(true), decide: () => Promise.resolve(true) };

function render(state: MemoryState, adding = false): string {
  return renderToString(<MemoryView memory={state} actions={actions} adding={adding} closeAdding={() => undefined} now={now} />);
}

describe("记忆", () => {
  it("shows nothing until the list is known, then says plainly that there is none", () => {
    expect(render(initialMemory)).not.toContain("还没有记忆");
    expect(render(receiveMemories({ memories: [], suggestions: [] }))).toContain("还没有记忆");
  });

  it("lists each memory as written, with who last wrote it and when, and a way to edit and to delete it", () => {
    const html = render(receiveMemories({ memories: [memory(1, "回答先说结论", "brain", now - 3_600_000), memory(2, "仓库一律用 pnpm\n不用 npm", "owner", now - 60_000)], suggestions: [] }));
    expect(html).not.toContain("还没有记忆");
    expect(html).not.toContain("待确认");
    expect(html).toContain("长期记忆");
    expect(html.indexOf("仓库一律用 pnpm")).toBeLessThan(html.indexOf("回答先说结论"));
    expect(html).toContain("仓库一律用 pnpm\n不用 npm");
    expect(html).toContain('<span class="chip">你</span>');
    expect(html).toContain('<span class="chip">大脑</span>');
    expect(html.match(/aria-label="改写"/g)).toHaveLength(2);
    expect(html.match(/aria-label="删除这条记忆"/g)).toHaveLength(2);
  });

  it("puts the suggestions waiting first, with 确认 and 不要, and what each would replace or remove struck through", () => {
    const html = render(
      receiveMemories({
        memories: [memory(1, "PR 失败时可以手动合并", "brain", now - 60_000), memory(2, "周报用中文写", "owner", now - 30_000)],
        suggestions: [suggestion(3, "PR 必须等 CI 全绿", { replaces: [1] }), suggestion(4, "周报用中文写", { kind: "forget", memory: 2 })],
      }),
    );
    expect(html.indexOf("待确认")).toBeLessThan(html.indexOf("长期记忆"));
    expect(html).toContain('<span class="count count--hot">2</span>');
    expect(html).toContain("确认后替换：");
    expect(html).toContain("<s>PR 失败时可以手动合并</s>");
    expect(html).toContain("确认后删除：");
    expect(html).toContain("<s>周报用中文写</s>");
    expect(html.match(/>确认</g)).toHaveLength(2);
    expect(html.match(/>不要</g)).toHaveLength(2);
  });

  it("opens an empty editor for a new memory, in place of the empty notice", () => {
    const html = render(receiveMemories({ memories: [], suggestions: [] }), true);
    expect(html).not.toContain("还没有记忆");
    expect(html).toContain('aria-label="新记忆"');
    expect(html).not.toContain("maxLength");
    expect(html).not.toContain("maxlength");
  });
});
