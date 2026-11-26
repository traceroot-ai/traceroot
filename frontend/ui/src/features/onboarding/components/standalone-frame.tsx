import type { ReactNode } from "react";

// The frame the app shell used to provide. This page renders outside the shell
// (see lib/chromeless-routes), so it is also outside the `<main>` that gave the
// old `h-full` something to resolve against — nothing sets a height on html or
// body, so a percentage height here collapses to the content. `min-h-screen` is
// what makes the empty background actually fill the screen, and `min-h-` rather
// than `h-` is what lets the box grow past the viewport once the step after the
// form is taller than it, instead of clipping the top of the card.
//
// Anchored at the top rather than centred, which is the whole of the layout fix.
// A centred column places its content from that content's own height, and the
// steps are nowhere near the same height: the manual walkthrough carries a
// twenty-card stack picker, a key field and two snippets, so at 1440x900 its
// document ran 1642px while the hand-back step fitted inside the 900px viewport.
// Centred, that put the header 248px down on the hand-back step and 16px down on
// the manual one — the icon, the heading and the description jumped 232px up the
// screen the moment the user pressed "Set up manually", and every step sat at a
// different height. `pt-24` fixes the header's distance from the top of the
// viewport at 96px on every step, because 96px is a number rather than a function
// of what is underneath it.
//
// 96px is higher up than the centred hand-back step used to sit, which is what
// was asked for, and it is six times the frame's old 16px padding — a deliberate
// band of space rather than a header clinging to the top edge, at a laptop
// viewport and at phone width alike. `pb-16` keeps the tall step from ending
// flush against the bottom of the viewport. `min-h-screen` rather than
// `h-screen` is what keeps the overflow scrollable instead of clipped, which is
// what both extremes need. The manual step runs past any viewport. The hand-back
// step fits a 390x844 phone exactly and takes about 100px of scroll on a 320x568
// one, where it used to fit: its content is 511px and the frame now adds 160px
// around it. That is the price of the anchor, and it is the right way round —
// a short step that scrolls a little on the smallest phone in exchange for a
// header that never moves.
export function StandaloneFrame({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center bg-background px-4 pb-16 pt-24">
      {children}
    </div>
  );
}
