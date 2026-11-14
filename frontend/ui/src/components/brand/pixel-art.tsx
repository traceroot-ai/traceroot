"use client";

import { useEffect, useRef, type CSSProperties } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * Pixel cubes for the auth brand panel, on the website's 8px grid with 6px
 * cells, over the share image's pixel field. The loop pauses offscreen,
 * settles to a still frame under prefers-reduced-motion and returns its cleanup.
 */

// Generated from https://traceroot.ai/social/blog.png (sha256 70ede3049fb71ab2...), the
// website's share image. Each character is one 24px cell of its pixel field
// (0 = empty, 1-5 = the image's five opacities); row 0 is the dense top edge.
// Regenerate from the image rather than editing by hand.
const SHARE_FIELD_OPACITY = [0, 0.08, 0.2, 0.4, 0.6, 0.8];

const SHARE_FIELD_ROWS = [
  "040303300434003434333003330040430002220000002202033044404334440043040035033302000000000000303033443",
  "003030403404334000334230030040030030203330000000030444444444004440404340042230200002302222330334440",
  "034400303033440333300334033003003200000020020200033334444445440044004334033000200022200222303044434",
  "303033403300444030040300302003200000020032200000003340455545044443000004300002003020200033000343303",
  "034033404300303404430000333003000020203002000200230030440400040400343003200030003022523022200040403",
  "003000333334504343033330000303020522020000023220030333345405444033330000323002020202002200303000434",
  "333304020044034044434043432020002200020000200300030304304400403343330032002200020000020000003303033",
  "000000300204304434000433000002020003202002123200300430454544444334003330350200000000202202333333333",
  "003300032003330030003404332030000000000002003300030304400544033434400002002020202000000002033033333",
  "333000223203300400034300003022000020220000230002000303444444044543000000002003220020002030202302000",
  "300033003303400000003330300002000220000010030030030030040430533344030000002000200022000200022000223",
  "000300020000000033003030030000200102001002020300200003304340343030000502202202002000000003020005203",
  "230000203300000300334532032210200010000520033025300004330303003030230102000002000002000000220003005",
  "030223303302302030330300002200022000010000032303020233000003030000002000022000221000200020000000202",
  "003500000320200033033022020002000020000000100500032000000033000002000020002002000000200020000020000",
  "200200000202200002002022300200101000000002000000200033020000332020220220001000010202020200015020020",
  "005003320320200200002000000220011000201002000002020200003000022230222000000002020020000020000002010",
  "002020000003000020000020010020000010001001020002302022000200200002001000101000100000020000020010010",
  "000003000002020002200200050202010010000000221200000000002000002202000000000020000000000000000000010",
  "000020000220000000500100020000000000000000000000000000000100000020002120000000000200020020100000000",
  "100000012000002000000021200000000100000010000200001100012000010002001000100010012000000200000010000",
  "000010000002002202000000010000000000000000000000000000000000000000000001000200000000151001100010021",
  "100000002000000000000012000000000000000012000200000000100000200000001000000010000010010200000000000",
  "000000100000000001000000000010000000000000000000000000000010000000100000020000000010001000000100000",
  "000002010000020200000000000000000000000000000010000000000000000000000000000000100000000000000000000",
  "010000100000021010000001000000000000000010000010000100001000000021000010000000021000000000000000100",
  "000000000000000000000000000100000000000000010000000001000000100000100000020001000000000010011000000",
  "000000010100000000000000000000000000000000000100000000000000000000000000000000000000000000000010000",
  "000000000000000000000000000000000000000000000001000000010000000000001000000000010000000000000000000",
  "000010000000000000000000000000000000000000000000000000000000000000000000001000010000000001000000000",
  "000000000000000000000000000000000000000000000000000000000000000000000000000000000100000000000000000",
  "000000000000000000000000000000000000000000000000000000000000010001000000000000000000000000000000000",
];

type Frame = (now: number, reduce: boolean) => void;

/**
 * requestAnimationFrame loop that runs only while the canvas is on screen.
 * `redraw` paints one frame, e.g. after a resize clears a still canvas.
 */
function runLoop(
  canvas: HTMLCanvasElement,
  frame: Frame,
): { stop: () => void; redraw: () => void } {
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let raf = 0;
  let visible = false;

  const tick = (now: number) => {
    frame(now, motion.matches);
    raf = visible && !motion.matches ? requestAnimationFrame(tick) : 0;
  };
  const start = () => {
    if (!raf) raf = requestAnimationFrame(tick);
  };
  const stop = () => {
    cancelAnimationFrame(raf);
    raf = 0;
  };
  const onMotion = () => {
    stop();
    start();
  };

  const observer = new IntersectionObserver(([entry]) => {
    visible = Boolean(entry?.isIntersecting);
    if (visible) start();
    else stop();
  });
  observer.observe(canvas);
  motion.addEventListener("change", onMotion);

  return {
    stop: () => {
      stop();
      observer.disconnect();
      motion.removeEventListener("change", onMotion);
    },
    redraw: start,
  };
}

function fitCanvas(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, w: number, h: number) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

/**
 * A 2:1 pixel-art isometric cube: every edge runs two cells across per cell
 * down, so the outline steps evenly. Callers pass grid-aligned values, which
 * keeps the shape identical from frame to frame as it moves.
 */
function cube(cx: number, cy: number, s: number) {
  const h = s / 2;
  const top: Point[] = [
    [cx, cy - h],
    [cx + s, cy],
    [cx, cy + h],
    [cx - s, cy],
  ];
  const left: Point[] = [
    [cx - s, cy],
    [cx, cy + h],
    [cx, cy + h + s],
    [cx - s, cy + s],
  ];
  const right: Point[] = [
    [cx + s, cy],
    [cx, cy + h],
    [cx, cy + h + s],
    [cx + s, cy + s],
  ];
  return [
    { poly: top, col: "#9ee1db" },
    { poly: left, col: "#2fbdb3" },
    { poly: right, col: "#0f827d" },
  ];
}

type Point = [number, number];

function inside(x: number, y: number, poly: Point[]): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/**
 * The panel background: solid pixel cubes in the brand teals that float
 * gently, the share image's pixel field rising from the bottom, and teal
 * comets sweeping along the rows. Sized to the canvas element; refits on resize.
 */
function mountPixelField(canvas: HTMLCanvasElement): (() => void) | undefined {
  const ctx = canvas.getContext("2d");
  if (!ctx) return undefined;
  const g = ctx;
  const P = 8;
  const S = 6;
  const ACCENT = "#14b8b0";

  let W = 0;
  let H = 0;
  let cols = 0;
  let rows = 0;
  let comets: { row: number; x: number; v: number }[] = [];

  const layout = () => {
    const rect = canvas.getBoundingClientRect();
    W = rect.width;
    H = rect.height;
    if (!W || !H) return;
    fitCanvas(canvas, g, W, H);
    cols = Math.ceil(W / P);
    rows = Math.ceil(H / P);
    comets = Array.from({ length: 7 }, () => ({
      row: (Math.random() * rows) | 0,
      x: -Math.random() * W,
      v: 160 + Math.random() * 160,
    }));
  };
  layout();

  let start: number | null = null;
  let prev = 0;
  const loop = runLoop(canvas, (now, reduce) => {
    if (start === null) start = now;
    const t = (now - start) / 1000;
    const dt = Math.min(0.05, (now - (prev || now)) / 1000);
    prev = now;
    g.clearRect(0, 0, W, H);

    // Whole-cell steps: a sub-cell offset would re-sample the faces and
    // change the cube's outline every frame.
    const snap = (v: number) => Math.round(v / P) * P;
    const bob = (k: number) => (reduce ? 0 : snap(Math.sin(t * 0.8 + k) * P));
    const narrow = W < 700;
    const m = Math.min(W, H);
    const place = (x: number, y: number, size: number, k: number) =>
      cube(snap(x), snap(y) + bob(k), Math.max(1, Math.round(size / (2 * P))) * 2 * P);
    const cubes = narrow
      ? [...place(W * 0.66, H * 0.36, m * 0.2, 0), ...place(W * 0.88, H * 0.5, m * 0.07, 1.7)]
      : [
          ...place(W * 0.7, H * 0.17, m * 0.15, 0),
          ...place(W * 0.92, H * 0.31, m * 0.065, 1.7),
          ...place(W * 0.48, H * 0.33, m * 0.05, 3.1),
        ];

    if (!reduce)
      for (const c of comets) {
        c.x += c.v * dt;
        if (c.x > W + 140) {
          c.x = -80 - Math.random() * 400;
          c.row = (Math.random() * rows) | 0;
          c.v = 160 + Math.random() * 160;
        }
      }

    for (let r = 0; r < rows; r++) {
      const y = r * P;
      for (let c = 0; c < cols; c++) {
        const x = c * P;
        let face: ReturnType<typeof cube>[number] | null = null;
        for (const f of cubes) if (inside(x + S / 2, y + S / 2, f.poly)) face = f;
        if (face) {
          g.globalAlpha = 1;
          g.fillStyle = face.col;
          g.fillRect(x, y, S, S);
          continue;
        }
        // The share image's field, flipped so its dense edge sits on the bottom.
        // On the short mobile header only the dense edge fits below the wordmark.
        const fieldRow = rows - 1 - r;
        if (narrow && fieldRow >= 4) continue;
        const level = SHARE_FIELD_ROWS[fieldRow]?.[c % SHARE_FIELD_ROWS[0]!.length];
        const opacity = SHARE_FIELD_OPACITY[Number(level ?? 0)] ?? 0;
        if (!opacity) continue;

        let color = ACCENT;
        let alpha = opacity;
        if (!reduce)
          for (const k of comets)
            if (k.row === r) {
              const d = k.x - x;
              if (d >= 0 && d < 110) {
                color = "#0f827d";
                alpha = 0.8 * (1 - d / 130);
              }
            }
        g.globalAlpha = alpha;
        g.fillStyle = color;
        g.fillRect(x, y, S, S);
      }
    }
    g.globalAlpha = 1;
  });

  // Resizing clears the canvas, which a still (reduced-motion) frame never repaints.
  const resize = new ResizeObserver(() => {
    layout();
    loop.redraw();
  });
  resize.observe(canvas);

  return () => {
    loop.stop();
    resize.disconnect();
  };
}

// footer-wordmark.runtime.js is an IIFE that publishes itself on globalThis.
type WordmarkRuntime = { mountFooterWordmark: (canvas: HTMLCanvasElement) => () => void };

// Home's wordmark settings, with the share image's teal ink and a deeper teal sweep.
const WORDMARK_STYLE = {
  "--accent": "#0f827d",
  "--wm-ink": "#14b8b0",
  "--wm-still": "1",
  "--wm-speed": "2",
  "--wm-hi": "0.85",
  "--wm-lo": "0.32",
} as CSSProperties;

/**
 * The website's animated pixel "traceroot" wordmark, run by the same generated
 * runtime the docs footer uses (docs/brand/footer-wordmark.runtime.js).
 */
export function PixelWordmark({ className }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let dispose: (() => void) | undefined;
    let cancelled = false;
    // Loaded on the client only: the runtime touches window as it evaluates.
    void import("./footer-wordmark.runtime.js").then(() => {
      const runtime = (globalThis as unknown as { TraceRootFooterWordmark?: WordmarkRuntime })
        .TraceRootFooterWordmark;
      if (!cancelled && ref.current && runtime) dispose = runtime.mountFooterWordmark(ref.current);
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, []);

  return (
    <canvas
      ref={ref}
      role="img"
      aria-label="traceroot"
      style={WORDMARK_STYLE}
      className={cn("block aspect-[800/128] w-full", className)}
    />
  );
}

/** Decorative pixel cubes over the share image's pixel field; fills its positioned parent. */
export function PixelField({ className }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => (ref.current ? mountPixelField(ref.current) : undefined), []);
  return (
    <canvas
      ref={ref}
      aria-hidden="true"
      className={cn("pointer-events-none absolute inset-0 h-full w-full", className)}
    />
  );
}

/** "Backed by Y Combinator" tag with YC's orange mark. */
export function YCBadge({ className }: { className?: string }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "gap-1.5 rounded-[2px] bg-background px-1.5 py-1 font-mono text-[11px] font-normal",
        className,
      )}
    >
      <b
        aria-hidden="true"
        className="grid h-3.5 w-3.5 place-items-center rounded-[1px] bg-[#f26522] text-[10px] font-semibold text-white"
      >
        Y
      </b>
      Backed by Y Combinator
    </Badge>
  );
}
