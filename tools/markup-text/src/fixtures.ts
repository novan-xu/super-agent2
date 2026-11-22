export interface Fixture {
  name: string;
  file: string;
  source: string;
  lines: number[];
}

const text = (...lines: string[]): string => `${lines.join("\n")}\n`;

const view = (...body: string[]): string[] => [
  'import { text } from "@super-agent2/catalog";',
  "",
  "export function View({ ok, count, items, state }: Props) {",
  ...body,
  "}",
];

export const flagged: Fixture[] = [
  {
    name: "text between tags",
    file: "between.tsx",
    source: text(...view("  return <p>Save the draft</p>;")),
    lines: [4],
  },
  {
    name: "text after an element and across lines",
    file: "across.tsx",
    source: text(
      ...view("  return (", "    <p>", "      {text('a')}", "      then wait", "    </p>", "  );"),
    ),
    lines: [7],
  },
  {
    name: "Chinese written in the markup",
    file: "chinese.tsx",
    source: text(...view("  return <button>设置</button>;")),
    lines: [4],
  },
  {
    name: "text beside an expression",
    file: "beside.tsx",
    source: text(...view("  return <p>{count} items left</p>;")),
    lines: [4],
  },
  {
    name: "a string in an expression",
    file: "string.tsx",
    source: text(...view('  return <p>{"Loading"}</p>;')),
    lines: [4],
  },
  {
    name: "a ternary",
    file: "ternary.tsx",
    source: text(...view('  return <p>{ok ? "Saved" : text("hold.answer.refused")}</p>;', '  return <p>{ok ? text("hold.answer.released") : "Failed"}</p>;')),
    lines: [4, 5],
  },
  {
    name: "a logical expression",
    file: "logical.tsx",
    source: text(...view('  return <p>{ok && "Ready"}</p>;', '  return <p>{state || "Unknown"}</p>;')),
    lines: [4, 5],
  },
  {
    name: "a template string",
    file: "template.tsx",
    source: text(...view("  return <p>{`${count} items`}</p>;", "  return <p>{`${ok ? `done` : text('a')}`}</p>;")),
    lines: [4, 5],
  },
  {
    name: "a concatenation",
    file: "concatenation.tsx",
    source: text(...view('  return <p>{"Total: " + count}</p>;')),
    lines: [4],
  },
  {
    name: "a wrapped expression",
    file: "wrapped.tsx",
    source: text(...view('  return <p>{(ok ? "Yes" : "No") as string}</p>;', '  return <p>{"Maybe"!}</p>;')),
    lines: [4, 4, 5],
  },
  {
    name: "a list of strings",
    file: "list.tsx",
    source: text(...view('  return <p>{["One", "Two"]}</p>;')),
    lines: [4, 4],
  },
  {
    name: "a string returned from a callback",
    file: "callback.tsx",
    source: text(
      ...view(
        '  return <ul>{items.map((item) => "Item")}</ul>;',
        '  return <ul>{items.map((item) => { if (item) { return "Item"; } return text("a"); })}</ul>;',
      ),
    ),
    lines: [4, 5],
  },
  {
    name: "a constant used as a label",
    file: "constant.tsx",
    source: text(
      'import { text } from "@super-agent2/catalog";',
      "",
      'const save = "Save";',
      "",
      "export function View() {",
      "  return <button>{save}</button>;",
      "}",
    ),
    lines: [3],
  },
  {
    name: "a lookup table used as a label",
    file: "lookup.tsx",
    source: text(
      "const labels = {",
      '  ready: "Ready",',
      '  failed: "Failed",',
      '  url: "/api/ready",',
      "} as const;",
      "",
      "const all = ['Waiting', 'Done'];",
      "",
      "export function View({ state, index }: Props) {",
      "  return <p>{labels[state]}{labels.ready}{all[index]}</p>;",
      "}",
    ),
    lines: [2, 3, 4, 7, 7],
  },
  {
    name: "shown attributes",
    file: "attributes.tsx",
    source: text(
      ...view(
        '  return <input placeholder="Search" />;',
        '  return <img src="/a.png" alt="A tree" />;',
        '  return <a href="/x" title="Open">{text("a")}</a>;',
        '  return <button aria-label="Close" />;',
        '  return <section aria-description="The list" aria-roledescription="card" />;',
        '  return <option value="a" label="Choice" />;',
      ),
    ),
    lines: [4, 5, 6, 7, 8, 8, 9],
  },
  {
    name: "shown attributes with an expression",
    file: "attribute-expression.tsx",
    source: text(
      ...view(
        '  return <p title={ok ? "Yes" : "No"} />;',
        '  return <p title={`Count ${count}`} />;',
        '  return <p aria-label={"Close"} />;',
      ),
    ),
    lines: [4, 4, 5, 6],
  },
  {
    name: "a component's text props",
    file: "component.tsx",
    source: text(
      ...view(
        '  return <Button label="Save" />;',
        '  return <Card heading={"Recent"} description={ok ? "On" : text("a")} />;',
        '  return <Dialog title="Delete" message="Are you sure?" />;',
      ),
    ),
    lines: [4, 5, 5, 6, 6],
  },
  {
    name: "a fragment and nested elements",
    file: "nested.tsx",
    source: text(
      ...view("  return (", "    <>", "      <main>", "        <section><h1>Title</h1></section>", "      </main>", "    </>", "  );"),
    ),
    lines: [7],
  },
  {
    name: "JSX written in a plain JavaScript file",
    file: "plain.jsx",
    source: text("export const view = <p>Hello</p>;"),
    lines: [1],
  },
  {
    name: "the document of the page",
    file: "index.html",
    source: text(
      "<!doctype html>",
      '<html lang="zh-CN">',
      "<head>",
      '  <meta charset="utf-8">',
      "  <title>Super Agent</title>",
      "</head>",
      "<body>",
      '  <div id="app" title="Home"></div>',
      "  <noscript>Enable scripts</noscript>",
      '  <script type="module" src="/src/main.tsx"></script>',
      "</body>",
      "</html>",
    ),
    lines: [5, 8, 9],
  },
];

export const clean: Fixture[] = [
  {
    name: "labels from the catalog",
    file: "catalog.tsx",
    source: text(
      ...view(
        '  return <p>{text("navigation.workbench")}</p>;',
        '  return <p>{ok ? text("hold.answer.released") : text("hold.answer.refused")}</p>;',
        '  return <p>{text("hold.reason", { description: "x", evidence: "y" })}</p>;',
        '  return <input placeholder={text("navigation.settings")} aria-label={ok ? text("a") : text("b")} />;',
        '  return <Button label={text("navigation.memory")} />;',
      ),
    ),
    lines: [],
  },
  {
    name: "what is not interface text",
    file: "structure.tsx",
    source: text(
      ...view(
        '  return <a className="link primary" id="main" key="k" href="https://example.com/a" target="_blank" rel="noreferrer" data-testid="x" role="button" type="button" name="field" htmlFor="field" lang="zh-CN" style={{ color: "red" }}>{text("a")}</a>;',
        '  return <Route path="/history" element={<Page variant="primary" size="small" icon="check" />} />;',
        '  return <input value={count} onChange={() => undefined} autoComplete="off" />;',
      ),
    ),
    lines: [],
  },
  {
    name: "whitespace, numbers and glyphs",
    file: "glyphs.tsx",
    source: text(
      ...view(
        '  return <p>{count}{" "}{text("a")} · {count} / {items.length} — {"×"}{404}</p>;',
        "  return <p>\n      {count}\n    </p>;",
        '  return <p>{`${count}/${items.length}`}{`  `}</p>;',
      ),
    ),
    lines: [],
  },
  {
    name: "constants and tables that are not shown",
    file: "tables.tsx",
    source: text(
      "const classes = { ready: 'badge badge-ready', failed: 'badge badge-failed' };",
      "const config = { url: '/api/ready', label: text('a') };",
      "const mutable = 'Save';",
      "let reassigned = 'Save';",
      "reassigned = text('a');",
      "",
      "export function View({ state }: Props) {",
      "  return <p className={classes[state]} title={config.label}>{config.label}{reassigned}</p>;",
      "}",
      "export function Other({ mutable: shown }: Props) {",
      "  return <p>{shown}</p>;",
      "}",
    ),
    lines: [],
  },
  {
    name: "expressions that only pass values on",
    file: "values.tsx",
    source: text(
      ...view(
        "  return <ul>{items.map((item) => <li key={item.id}>{item.name}</li>)}</ul>;",
        "  return <ul>{items.filter((item) => item.name === 'done').map((item) => item.id)}</ul>;",
        "  return <p>{items.length > 0 ? count : 0}</p>;",
        "  return <p>{state === 'ready' && <b>{count}</b>}</p>;",
      ),
    ),
    lines: [],
  },
];
