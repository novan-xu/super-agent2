import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { FileViewer } from "./FileViewer.js";

it("renders a sandboxed HTML document and switches to its original source", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const source = '<!doctype html><html><head><style>body { color: red }</style></head><body><img src="data:image/png;base64,aGVsbG8="><script>parent.compromised = true</script></body></html>';
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(source)));
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => { root.render(<FileViewer files={[{ name: "page.html", mime: "text/html", size: source.length, url: "/page" }]} index={0} close={() => undefined} />); });
    const frame = host.querySelector("iframe")!;
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("src")).toBe("/page/render");
    expect(frame.hasAttribute("srcdoc")).toBe(false);
    await act(async () => host.querySelector<HTMLButtonElement>(".fv-toggle")!.click());
    expect(host.querySelector("iframe")).toBeNull();
    expect(host.querySelector("pre")?.textContent).toBe(source);
    await act(async () => host.querySelector<HTMLButtonElement>(".fv-toggle")!.click());
    expect(host.querySelector("iframe")?.getAttribute("sandbox")).toBe("");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
