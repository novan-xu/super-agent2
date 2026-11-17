import type { Memory } from "@super-agent2/protocol";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { initialMemory, type MemoryState, receiveMemories } from "../live/memory.js";
import { MemoryView } from "./MemoryView.js";

const now = Date.UTC(2026, 10, 17, 12, 0, 0);

function memory(id: number, zh: string, by: Memory["by"], changedAt: number): Memory {
  return { id, text: { en: `Memory ${id}`, zh }, by, stale: by === "owner", revision: id, createdAt: changedAt, changedAt };
}

function render(state: MemoryState): string {
  return renderToString(<MemoryView memory={state} actions={{ edit: () => Promise.resolve(true), remove: () => Promise.resolve(true) }} now={now} />);
}

describe("记忆", () => {
  it("shows nothing until the list is known, then says plainly that there is none", () => {
    expect(render(initialMemory)).not.toContain("还没有记忆");
    expect(render(receiveMemories([]))).toContain("还没有记忆");
  });

  it("lists each memory in Chinese with who last wrote it and when, and a way to edit and to delete it", () => {
    const html = render(receiveMemories([memory(1, "回答先说结论", "brain", now - 3_600_000), memory(2, "仓库一律用 pnpm", "owner", now - 60_000)]));
    expect(html).not.toContain("还没有记忆");
    expect(html).not.toContain("Memory 1");
    expect(html.indexOf("仓库一律用 pnpm")).toBeLessThan(html.indexOf("回答先说结论"));
    expect(html).toContain('<span class="chip">你</span>');
    expect(html).toContain('<span class="chip">大脑</span>');
    expect(html.match(/aria-label="改写"/g)).toHaveLength(2);
    expect(html.match(/aria-label="删除这条记忆"/g)).toHaveLength(2);
  });
});
