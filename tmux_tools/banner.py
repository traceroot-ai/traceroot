"""Terminal banner for the `make dev` welcome screen.

The wordmark is the pixel-grid `traceroot` from the traceroot.ai footer: ink
pixels plus a few teal accent pixels. The loop underneath is the same four steps
the landing page walks through.
"""

from __future__ import annotations

import os
import shutil

# "#" = ink, "*" = accent, "." = empty. One character per pixel, 53 x 7.
_GRID = (
    ".#...............................................#...",
    ".#...............................................#...",
    "###*..#.##...###...###...###..#.##...###...###..####.",
    ".#....##..#.....#.#...#.#...#.##..#.*...#.#...#..#...",
    ".#....#......####.#.....####*.#.....#...#.#...#..#...",
    ".#..#.#.....#...#.#...#.#.....#.....#...#.#...#..#..#",
    "..##..#......####..###...###..#......###...###....*#.",
)
_WIDTH = max(len(row) for row in _GRID)

# Wide enough for the two-columns-per-pixel wordmark (106 columns) plus margin.
FULL_MIN_COLUMNS = 110

TAGLINE = "the open-source platform that continuously improves your ai agents"
LOOP = (
    "trace ──▶ detect ──▶ signals ──▶ verify ──╮",
    "  ▲                                       │",
    "  ╰──────── your agent in production ◀────╯",
)

_RESET = "\033[0m"
_TEAL = (20, 184, 176)  # --accent on traceroot.ai
_GRAY = (138, 141, 144)  # --g40 on traceroot.ai


def _truecolor() -> bool:
    return os.environ.get("COLORTERM", "").lower() in ("truecolor", "24bit")


def _fg(rgb: tuple[int, int, int], teal: bool) -> str:
    if _truecolor():
        return "\033[38;2;{};{};{}m".format(*rgb)
    return "\033[38;5;37m" if teal else "\033[2m"  # 256-colour teal, else dim


def _bg(rgb: tuple[int, int, int], teal: bool) -> str:
    if _truecolor():
        return "\033[48;2;{};{};{}m".format(*rgb)
    return "\033[48;5;37m" if teal else ""


def _wordmark_full() -> list[str]:
    """Two terminal columns per pixel: square pixels, 7 rows."""
    teal = _fg(_TEAL, True)
    lines = []
    for row in _GRID:
        out = ""
        for px in row.ljust(_WIDTH, "."):
            if px == "#":
                out += "\033[1m██" + _RESET
            elif px == "*":
                out += teal + "██" + _RESET
            else:
                out += "  "
        lines.append(out.rstrip())
    return lines


def _wordmark_half() -> list[str]:
    """Two pixel rows per terminal row (half blocks): 53 columns, 4 rows."""
    rows = [row.ljust(_WIDTH, ".") for row in _GRID]
    if len(rows) % 2:
        rows.append("." * _WIDTH)
    lines = []
    for y in range(0, len(rows), 2):
        out = ""
        for top, bottom in zip(rows[y], rows[y + 1], strict=True):
            if top == "." and bottom == ".":
                out += " "
            elif top == bottom:
                out += _cell("█", top)
            elif bottom == ".":
                out += _cell("▀", top)
            elif top == ".":
                out += _cell("▄", bottom)
            else:  # ink above accent, or the reverse: fg = top, bg = bottom
                out += _cell("▀", top, under=bottom)
        lines.append(out.rstrip())
    return lines


def _cell(char: str, px: str, under: str | None = None) -> str:
    style = _fg(_TEAL, True) if px == "*" else "\033[1m"
    if under is not None:
        style += _bg(_TEAL, True) if under == "*" else "\033[47m" if _truecolor() else ""
    return style + char + _RESET


def _loop() -> list[str]:
    teal, gray, bold = _fg(_TEAL, True), _fg(_GRAY, False), "\033[1m"
    steps = ("trace", "detect", "signals", "verify")
    arrow = teal + " ──▶ " + _RESET
    first = arrow.join(bold + step + _RESET for step in steps) + teal + " ──╮" + _RESET
    return [
        " " + first,
        " " + teal + "  ▲" + _RESET + gray + "                                       │" + _RESET,
        " " + teal + "  ╰──────── your agent in production ◀────╯" + _RESET,
    ]


def render_banner(columns: int | None = None) -> str:
    """The banner as ANSI text. Uses the wide wordmark only when it fits."""
    if os.environ.get("NO_COLOR"):
        return _plain(columns)
    columns = columns or shutil.get_terminal_size((80, 24)).columns
    wordmark = _wordmark_full() if columns >= FULL_MIN_COLUMNS else _wordmark_half()
    gray = _fg(_GRAY, False)
    lines = [*wordmark, "", " " + gray + TAGLINE + _RESET, "", *_loop()]
    return "\n".join(lines)


def _plain(columns: int | None) -> str:
    columns = columns or shutil.get_terminal_size((80, 24)).columns
    full = columns >= FULL_MIN_COLUMNS
    out = []
    if full:
        for row in _GRID:
            out.append("".join("██" if px in "#*" else "  " for px in row).rstrip())
    else:
        rows = [row.ljust(_WIDTH, ".") for row in _GRID] + ["." * _WIDTH]
        for y in range(0, len(rows) - 1, 2):
            line = ""
            for top, bottom in zip(rows[y], rows[y + 1], strict=True):
                t, b = top != ".", bottom != "."
                line += "█" if t and b else "▀" if t else "▄" if b else " "
            out.append(line.rstrip())
    return "\n".join([*out, "", " " + TAGLINE, "", *(" " + line for line in LOOP)])
