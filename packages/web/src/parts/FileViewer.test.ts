import { expect, it } from "vitest";
import css from "../styles/page.css?raw";

it("lets HTML previews use the browser color preference without a forced background", () => {
  const rule = css.match(/\.fv-html\s*\{([^}]*)\}/)?.[1] ?? "";
  expect(rule).toMatch(/color-scheme:\s*light dark\s*;/);
  expect(rule).not.toMatch(/background(?:-color)?:/);
});
