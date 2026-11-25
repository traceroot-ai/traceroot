import type { KeyboardEvent } from "react";

const IME_KEY_CODE = 229;

export function isImeComposition(event: KeyboardEvent<HTMLElement>): boolean {
  return event.nativeEvent.isComposing || event.nativeEvent.keyCode === IME_KEY_CODE;
}
