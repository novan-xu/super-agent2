import type { KeyboardEvent } from "react";

export function sendsOnEnter(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
  if (event.key !== "Enter" || event.shiftKey || event.altKey || event.nativeEvent.isComposing || event.keyCode === 229) {
    return false;
  }
  return !(window.matchMedia("(pointer: coarse)").matches && !(event.ctrlKey || event.metaKey));
}
