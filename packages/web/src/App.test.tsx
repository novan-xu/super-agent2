import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { App } from "./App";

describe("App", () => {
  it("renders the main region", () => {
    expect(renderToString(<App />)).toBe('<main class="main">Super-agent2</main>');
  });
});
