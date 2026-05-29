import { describe, it, expect } from "vitest";
import { mediaSrc } from "./inline-media";

// Build a base64 string from a binary header, padded past the bare-base64
// length threshold (mediaSrc ignores strings shorter than 100 chars).
function bare(header: number[] | string, totalBytes = 90): string {
  const head = typeof header === "string" ? Array.from(header, (c) => c.charCodeAt(0)) : header;
  const buf = Buffer.alloc(totalBytes);
  buf.set(head, 0);
  return buf.toString("base64");
}

// RIFF container: "RIFF" + 4-byte size + a form tag at offset 8.
function riff(form: string): string {
  const buf = Buffer.alloc(90);
  buf.set(
    Array.from("RIFF", (c) => c.charCodeAt(0)),
    0,
  );
  buf.set([0x24, 0, 0, 0], 4);
  buf.set(
    Array.from(form, (c) => c.charCodeAt(0)),
    8,
  );
  return buf.toString("base64");
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff, 0xe0];
const MP3_FRAME = [0xff, 0xfb];

describe("mediaSrc — data URIs", () => {
  it("detects an image data URI", () => {
    const uri = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
    expect(mediaSrc(uri)).toEqual({ src: uri, kind: "image" });
  });

  it("detects an audio data URI", () => {
    const uri = "data:audio/mpeg;base64,SUQzAAAAAAAA";
    expect(mediaSrc(uri)).toEqual({ src: uri, kind: "audio" });
  });

  it("rejects svg data URIs (XSS)", () => {
    expect(mediaSrc("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=")).toBeNull();
  });
});

describe("mediaSrc — bare base64 (magic-byte sniffing)", () => {
  it("detects PNG", () => {
    expect(mediaSrc(bare(PNG))?.kind).toBe("image");
    expect(mediaSrc(bare(PNG))?.src).toMatch(/^data:image\/png;base64,/);
  });

  it("detects JPEG", () => {
    expect(mediaSrc(bare(JPEG))?.kind).toBe("image");
    expect(mediaSrc(bare(JPEG))?.src).toMatch(/^data:image\/jpeg;base64,/);
  });

  it("detects GIF", () => {
    expect(mediaSrc(bare("GIF89a"))?.kind).toBe("image");
  });

  it("detects MP3 via ID3 tag", () => {
    expect(mediaSrc(bare("ID3"))?.kind).toBe("audio");
    expect(mediaSrc(bare("ID3"))?.src).toMatch(/^data:audio\/mpeg;base64,/);
  });

  it("detects MP3 via frame sync", () => {
    expect(mediaSrc(bare(MP3_FRAME))?.kind).toBe("audio");
  });

  it("detects OGG", () => {
    expect(mediaSrc(bare("OggS"))?.kind).toBe("audio");
  });

  // The RIFF collision: WAV and WebP share the "UklGR" base64 prefix and can
  // only be told apart by the format tag at byte offset 8.
  it("distinguishes WAV (audio) from WebP (image) — both are RIFF", () => {
    expect(mediaSrc(riff("WAVE"))).toMatchObject({ kind: "audio" });
    expect(mediaSrc(riff("WAVE"))?.src).toMatch(/^data:audio\/wav;base64,/);
    expect(mediaSrc(riff("WEBP"))).toMatchObject({ kind: "image" });
    expect(mediaSrc(riff("WEBP"))?.src).toMatch(/^data:image\/webp;base64,/);
  });

  it("ignores other RIFF containers (e.g. AVI)", () => {
    expect(mediaSrc(riff("AVI "))).toBeNull();
  });
});

describe("mediaSrc — non-media", () => {
  it("returns null for short strings", () => {
    expect(mediaSrc("hello")).toBeNull();
    expect(mediaSrc("data:image/png;base64,iVBOR")).not.toBeNull(); // sanity: valid short data URI still matches
  });

  it("returns null for long plain text", () => {
    expect(mediaSrc("the quick brown fox jumps over the lazy dog ".repeat(5))).toBeNull();
  });

  it("returns null for long non-media base64", () => {
    expect(mediaSrc(bare("hello world this is not media"))).toBeNull();
  });
});
