"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

/**
 * False in the HTML the server sends and until React has taken over the page,
 * then true. An auth form keeps its submit button disabled until then, so a
 * click or Enter before its handler is attached leaves the person on the form
 * instead of submitting it natively.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}
