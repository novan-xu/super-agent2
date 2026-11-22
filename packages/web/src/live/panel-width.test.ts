import { describe, expect, it } from "vitest";
import { clampPanelWidth, panelMaximum, parsePanelWidth } from "./panel-width.js";

describe("workbench panel width", () => {
  it("parses only valid stored widths", () => {
    for (const value of [null, "", "NaN", "Infinity", "-1", "299", "400px", "1e3"]) expect(parsePanelWidth(value)).toBe(380);
    expect(parsePanelWidth("300")).toBe(300);
    expect(parsePanelWidth("615.5")).toBe(615.5);
  });

  it("keeps space for the canvas and splitter", () => {
    expect(panelMaximum(1200)).toBe(932);
    expect(panelMaximum(500)).toBe(300);
    expect(clampPanelWidth(100, 752)).toBe(300);
    expect(clampPanelWidth(900, 752)).toBe(752);
    expect(clampPanelWidth(420.6, 752)).toBe(421);
  });
});
