"use client";

export type Media = { src: string; kind: "image" | "audio" };

// Raster images + audio. image/svg+xml is excluded because data-URI SVG can
// execute embedded script (XSS).
const MEDIA_DATA_URI =
  /^data:(image\/(?:png|jpe?g|gif|webp)|audio\/(?:mpeg|mp3|wav|x-wav|ogg|webm));base64,[A-Za-z0-9+/=]+$/i;

// A bare base64 blob is a single CONTIGUOUS run of the base64 alphabet with valid
// padding and a length that is a multiple of 4. Prose, code, and shell output
// never satisfy this — they contain spaces, newlines, and characters like '.',
// '-', ':' that are not in the alphabet — so they are never treated as candidate
// media. This anchored, whole-string check (not a decode-and-sniff of the first
// few bytes) is what keeps a "// comment" file dump from being mistaken for an
// MP3: such text is not contiguous base64, so it is rejected before any matching.
const BARE_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

// Known media identified by their base64 *encoding* prefix. Matching the encoded
// prefix (rather than decoding bytes and comparing a 2-byte magic number) keeps
// the check specific: these prefixes are 4–11 base64 chars, so a short ambiguous
// string cannot collide with them. Notably there is no bare MP3 frame-sync check
// (0xFF 0xEx) — it is only 11 bits and any "//"-prefixed text decodes to it, which
// is exactly how source code got mislabeled as audio. ID3-tagged MP3 (SUQz) still
// matches.
const IMAGE_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ["iVBORw0KGgo", "image/png"],
  ["/9j/", "image/jpeg"],
  ["R0lGOD", "image/gif"], // GIF87a / GIF89a
];
const AUDIO_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ["SUQz", "audio/mpeg"], // ID3 tag
  ["T2dnUw", "audio/ogg"], // "OggS"
];

const dataUri = (mime: string, b64: string): string => `data:${mime};base64,${b64}`;

// RIFF containers (base64 prefix "UklGR") cover both WAVE (audio) and WEBP (image)
// and can only be told apart by the 4-byte form tag at byte offset 8. The value is
// already validated as contiguous base64, so a narrow decode of just the header is
// safe and unambiguous here.
function riffMedia(b64: string): Media | null {
  let form: string;
  try {
    const bin = atob(b64.slice(0, 16)); // 16 base64 chars → 12 bytes: reaches the form tag at offset 8
    form = bin.slice(8, 12);
  } catch {
    return null;
  }
  if (form === "WEBP") return { src: dataUri("image/webp", b64), kind: "image" };
  if (form === "WAVE") return { src: dataUri("audio/wav", b64), kind: "audio" };
  return null; // other RIFF (e.g. AVI) — not handled
}

// Returns renderable media for inline base64 (data URIs and bare base64), or null.
export function mediaSrc(value: string): Media | null {
  const uri = value.match(MEDIA_DATA_URI);
  if (uri) {
    return { src: value, kind: uri[1].toLowerCase().startsWith("image/") ? "image" : "audio" };
  }

  // Only a fully-contiguous base64 blob past the length threshold is a candidate.
  // Anything with whitespace, prose, or punctuation is rejected outright.
  if (value.length < 100 || value.length % 4 !== 0 || !BARE_BASE64.test(value)) return null;

  for (const [prefix, mime] of IMAGE_PREFIXES) {
    if (value.startsWith(prefix)) return { src: dataUri(mime, value), kind: "image" };
  }
  for (const [prefix, mime] of AUDIO_PREFIXES) {
    if (value.startsWith(prefix)) return { src: dataUri(mime, value), kind: "audio" };
  }
  if (value.startsWith("UklGR")) return riffMedia(value);
  return null;
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
