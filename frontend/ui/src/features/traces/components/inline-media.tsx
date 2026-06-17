"use client";

export type Media = { src: string; kind: "image" | "audio" };

// Raster images + audio. image/svg+xml is excluded because data-URI SVG can
// execute embedded script (XSS).
const MEDIA_DATA_URI =
  /^data:(image\/(?:png|jpe?g|gif|webp)|audio\/(?:mpeg|mp3|wav|x-wav|ogg|webm));base64,[A-Za-z0-9+/=]+$/i;

// Sniff real magic bytes from a decoded base64 prefix. This correctly
// disambiguates RIFF containers (WEBP image vs WAVE audio), which share the
// same base64 prefix and cannot be told apart by string matching alone.
function sniffBase64(b64: string): Media | null {
  let bytes: Uint8Array;
  try {
    const bin = atob(b64.slice(0, 24)); // ~18 bytes — enough for the RIFF format tag at offset 8
    bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
  const tag = (i: number, n: number) => String.fromCharCode(...bytes.slice(i, i + n));
  const image = (mime: string): Media => ({ src: `data:${mime};base64,${b64}`, kind: "image" });
  const audio = (mime: string): Media => ({ src: `data:${mime};base64,${b64}`, kind: "audio" });

  if (bytes[0] === 0x89 && tag(1, 3) === "PNG") return image("image/png");
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return image("image/jpeg");
  if (tag(0, 4) === "GIF8") return image("image/gif");
  if (tag(0, 4) === "RIFF") {
    const form = tag(8, 4);
    if (form === "WEBP") return image("image/webp");
    if (form === "WAVE") return audio("audio/wav");
    return null; // other RIFF (e.g. AVI) — not handled
  }
  if (tag(0, 3) === "ID3" || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0))
    return audio("audio/mpeg");
  if (tag(0, 4) === "OggS") return audio("audio/ogg");
  return null;
}

// Returns renderable media for inline base64 (data URIs and bare base64), or null.
export function mediaSrc(value: string): Media | null {
  const m = value.match(MEDIA_DATA_URI);
  if (m) return { src: value, kind: m[1].toLowerCase().startsWith("image/") ? "image" : "audio" };
  if (value.length < 100) return null;
  return sniffBase64(value);
}

export function InlineMedia({ src, kind }: Media) {
  if (kind === "audio") {
    return <audio controls src={src} className="my-1 max-w-full" />;
  }
  return (
    <img
      src={src}
      alt="Inline image"
      className="my-1 max-h-64 max-w-full rounded border border-border"
    />
  );
}
