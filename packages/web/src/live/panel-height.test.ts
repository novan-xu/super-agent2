import { describe, expect, it } from "vitest";
import { clampPanelHeight, panelHeightMaximum, parsePanelHeight } from "./panel-height.js";

describe("workbench panel height", () => {
  it("parses only valid stored heights", () => {
    for (const value of [null, "", "NaN", "Infinity", "-1", "259", "400px", "1e3"]) expect(parsePanelHeight(value)).toBeNull();
    expect(parsePanelHeight("260")).toBe(260);
    expect(parsePanelHeight("615.5")).toBe(615.5);
  });

  it("clamps the panel while reserving canvas and splitter space", () => {
    expect(panelHeightMaximum(1000)).toBe(792);
    expect(panelHeightMaximum(400)).toBe(260);
    expect(clampPanelHeight(100, 792)).toBe(260);
    expect(clampPanelHeight(900, 792)).toBe(792);
    expect(clampPanelHeight(420.6, 792)).toBe(421);
  });
});
