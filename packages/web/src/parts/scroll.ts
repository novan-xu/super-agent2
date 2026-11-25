export function centerIn(element: Element, container: HTMLElement | null, behavior: ScrollBehavior = "auto"): void {
  if (container === null) return;
  const target = element.getBoundingClientRect();
  const bounds = container.getBoundingClientRect();
  container.scrollTo?.({ top: container.scrollTop + target.top - bounds.top - (container.clientHeight - target.height) / 2, behavior });
}
