export type LayoutTargets = Readonly<Record<string, string>>;

export function layoutProblems({ targets, width }: { targets: LayoutTargets; width: number }): string[] {
  const root = document.documentElement;
  const problems: string[] = [];
  const outside = (box: DOMRect, left: number, right: number) => box.left < left - 0.5 || box.right > right + 0.5;
  const visible = (element: Element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility === "visible";
  const span = (box: DOMRect) => `x=${box.left.toFixed(1)} to ${box.right.toFixed(1)}`;
  const name = (element: Element) => {
    const tag = element.tagName.toLowerCase();
    const classes = [...element.classList].slice(0, 3).map((value) => `.${value}`).join("");
    return element.id ? `${tag}#${element.id}` : tag + classes;
  };

  if (window.innerWidth !== width) {
    problems.push(`window.innerWidth is ${window.innerWidth}px, expected ${width}px`);
  }
  if (root.scrollWidth > width) {
    problems.push(`html scrollWidth is ${root.scrollWidth}px, wider than the ${width}px viewport`);
  }

  for (const [label, selector] of Object.entries(targets)) {
    const elements = Array.from(document.querySelectorAll(selector)).filter(visible);
    if (elements.length === 0) {
      problems.push(`${label} (${selector}) is missing or hidden`);
      continue;
    }
    for (const element of elements) {
      const box = element.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0 || outside(box, 0, width)) {
        problems.push(`${label} (${name(element)}) has ${span(box)} in a ${width}px viewport`);
        continue;
      }
      for (let child = element; child.parentElement !== null; child = child.parentElement) {
        if (getComputedStyle(child).position === "fixed") break;
        const parent = child.parentElement;
        if (parent.clientWidth === 0 || getComputedStyle(parent).overflowX === "visible") continue;
        const left = parent.getBoundingClientRect().left + parent.clientLeft;
        if (!outside(box, left, left + parent.clientWidth)) continue;
        problems.push(`${label} (${name(element)}) at ${span(box)} is clipped horizontally by ${name(parent)}`);
        break;
      }
    }
  }

  const scrollRegions = ".wb-tabs-scroll, .msg-text pre, .msg-text table";
  const overflowing = Array.from(document.body.querySelectorAll("*")).filter((element) =>
    (element instanceof HTMLElement || element instanceof SVGSVGElement)
    && element.closest(".sr-only") === null
    && element.parentElement?.closest(scrollRegions) == null
    && visible(element)
    && outside(element.getBoundingClientRect(), 0, width),
  );
  for (const element of overflowing.slice(0, 8)) {
    problems.push(`${name(element)} extends beyond the viewport (${span(element.getBoundingClientRect())})`);
  }
  return problems;
}
