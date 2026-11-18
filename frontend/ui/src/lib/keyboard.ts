import type { KeyboardEvent } from "react";

// keyCode 229: Safari can end composition before dispatching the Enter that confirms it.
export function isSubmitEnter(e: KeyboardEvent): boolean {
  return e.key === "Enter" && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229;
}
