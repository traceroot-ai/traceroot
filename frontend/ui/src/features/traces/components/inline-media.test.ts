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

describe("mediaSrc — bare base64 (encoding-prefix matching)", () => {
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

  // Bare MP3 frame sync (0xFF 0xEx) is deliberately NOT detected: it is only 11
  // bits and collides with ordinary text — e.g. any string starting with "//"
  // base64-decodes to 0xFF 0xF…. Detecting it mislabels source code as audio
  // (see the "non-media" regression cases below). ID3-tagged MP3 is still caught.
  it("does NOT detect bare MP3 frame sync (too ambiguous)", () => {
    expect(mediaSrc(bare(MP3_FRAME))).toBeNull();
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

  // Regression: real pi/coding-agent bash tool output was mis-detected as audio.
  // These are actual `sandbox_shell` results from prod trace
  // c474ea5cc57670f835bdc46992eb7ec4. A leading "//" JS comment base64-decodes to
  // an MP3 frame sync, so the old byte-sniffer rendered an <audio> player over the
  // source code. Plain text is not contiguous base64 (spaces/newlines/'.'), so it
  // must never be treated as media.
  it("returns null for a JS source dump starting with // (was mis-detected as audio)", () => {
    const jsFile =
      "// Minimal user lookup used by the API layer.\n" +
      'const { runQuery } = require("./client");\n\n' +
      "// Fetch a user by id from the request. The id comes straight from the\n" +
      "// untrusted query string.\n" +
      "function getUser(req) {\n" +
      "  const id = req.query.id;\n" +
      '  const sql = "SELECT * FROM users WHERE id = \'" + id + "\'";\n' +
      "  return runQuery(sql);\n" +
      "}\n\nmodule.exports = { getUser };";
    expect(jsFile.length).toBeGreaterThan(100); // clears the length threshold
    expect(mediaSrc(jsFile)).toBeNull();
  });

  it("returns null for `ls -la` command output", () => {
    const lsOut =
      "total 8\n" +
      "drwxr-xr-x 4 repair repair 120 Jul 20 05:37 .\n" +
      "drwxr-xr-x 3 repair repair  96 Jul 20 05:37 ..\n" +
      "drwxr-xr-x 2 repair repair  64 Jul 20 05:37 src";
    expect(mediaSrc(lsOut)).toBeNull();
  });
});
