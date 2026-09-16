import type { SseFrame } from "./types.js";

/**
 * Incremental parser for the agent service's SSE stream.
 *
 * The service writes one frame per agent event (`event: <type>` plus a
 * JSON `data:` line). Chunk boundaries fall anywhere, so frames are only
 * emitted once their terminating blank line has arrived.
 */
export interface SseParser {
  /** Feed a decoded chunk; returns whatever frames it completed. */
  push(chunk: string): SseFrame[];
}

function parseFrame(raw: string): SseFrame | null {
  let event = "message";
  const data: string[] = [];

  for (const line of raw.split("\n")) {
    // Blank padding and `:` comment lines (keep-alives) carry no fields.
    if (line === "" || line.startsWith(":")) continue;

    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    // Exactly one optional space after the colon belongs to the framing.
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }

  // A frame with neither an event name nor data is pure framing noise.
  if (event === "message" && data.length === 0) return null;
  return { event, data: data.join("\n") };
}

export function createSseParser(): SseParser {
  let buffer = "";

  return {
    push(chunk: string): SseFrame[] {
      // Normalize after appending so a CRLF split across chunks still collapses.
      buffer = (buffer + chunk).replace(/\r\n/g, "\n");

      const frames: SseFrame[] = [];
      for (;;) {
        const end = buffer.indexOf("\n\n");
        if (end === -1) break;
        const frame = parseFrame(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
        if (frame) frames.push(frame);
      }
      return frames;
    },
  };
}
