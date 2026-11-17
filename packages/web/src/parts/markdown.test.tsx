import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { toolName, toolSummary } from "../live/tool.js";
import { Markdown } from "./Markdown.js";

describe("Markdown", () => {
  it("formats the brain's prose", () => {
    const html = renderToString(<Markdown text={"**完成**了，见 `pnpm check`。\n\n- 一\n- 二"} />);
    expect(html).toContain("<strong>完成</strong>");
    expect(html).toContain("<code>pnpm check</code>");
    expect(html).toContain("<li>一</li>");
  });

  it("shows raw HTML as text, never as markup", () => {
    const html = renderToString(<Markdown text={'看这里 <script>alert(1)</script> 和 <img src=x onerror="alert(2)">'} />);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html.replaceAll("<!-- -->", "")).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("drops script links and opens other links apart from the page", () => {
    const html = renderToString(<Markdown text={"[坏](javascript:alert(1)) [好](https://github.com/novan-xu)"} />);
    expect(html).not.toContain("javascript:");
    expect(html).toContain('href="https://github.com/novan-xu" target="_blank" rel="noopener noreferrer"');
  });

  it("turns an image into a link rather than loading it", () => {
    const html = renderToString(<Markdown text={"![图](https://example.com/a.png)"} />);
    expect(html).not.toContain("<img");
    expect(html).toContain('href="https://example.com/a.png"');
  });

  it("keeps code blocks as they are", () => {
    const html = renderToString(<Markdown text={"```sh\nrm -rf <dir> && echo \"done\"\n```"} />);
    expect(html).toContain("<pre><code");
    expect(html).toContain("rm -rf &lt;dir&gt; &amp;&amp; echo &quot;done&quot;");
  });
});

describe("tool summaries", () => {
  it("shows the command a tool runs", () => {
    expect(toolSummary(JSON.stringify({ target: "hub", command: "gh pr list\n--state open" }))).toBe("gh pr list");
    expect(toolSummary("gh issue view 6")).toBe("gh issue view 6");
    expect(toolSummary(JSON.stringify({ command: ["git", "status"] }))).toBe("git status");
    expect(toolSummary("x".repeat(400))).toHaveLength(160);
  });

  it("names an MCP tool by its own name", () => {
    expect(toolName("mcp__hub__run_command")).toBe("run_command");
    expect(toolName("Bash")).toBe("Bash");
  });
});
