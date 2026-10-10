import { describe, expect, it, vi } from "vitest";
import { decide } from "../decide.js";
import type { AssignmentModels, Candidate, SignalText } from "../types.js";

const cand = (label: string): Candidate => ({
  label,
  signalId: `sig-${label}`,
  title: `T ${label}`,
  covers: `C ${label}`,
  excludes: `E ${label}`,
  example: `example ${label}`,
  status: "open",
  hitCount: 1,
  criteriaVersion: 3,
});
const NEW: SignalText = { title: "New", covers: "covers new", excludes: "" };

function models(over: {
  chatAssign?: { choice: string; newSignal?: SignalText | null };
  jev?: { choice: string; p: number } | null;
  accepted?: boolean[];
}) {
  const accepted = over.accepted ?? [true, false, false];
  const chat = {
    assign: vi.fn(async () => ({
      choice: over.chatAssign?.choice ?? "none",
      reason: "because",
      newSignal: over.chatAssign?.newSignal ?? null,
    })),
    write: vi.fn(async () => NEW),
    validate: vi.fn(async (_c: string, _e: string, texts: readonly string[]) =>
      accepted.slice(0, texts.length),
    ),
  };
  const jev = over.jev
    ? {
        assign: vi.fn(async () => ({
          choice: over.jev!.choice,
          probabilities: { [over.jev!.choice]: over.jev!.p },
        })),
        validate: vi.fn(async (_c: string, _e: string, texts: readonly string[]) =>
          accepted.slice(0, texts.length),
        ),
      }
    : null;
  return { chat, jev, all: { chat, jev } as AssignmentModels };
}

describe("decide", () => {
  it("writes the first signal of a partition without an assignment call", async () => {
    const m = models({ accepted: [true] });
    const d = await decide("hit", [], m.all);
    expect(d).toMatchObject({ kind: "create", signal: NEW, validated: true, decidedBy: "empty" });
    expect(m.chat.assign).not.toHaveBeenCalled();
    expect(m.chat.validate).toHaveBeenCalledWith("covers new", "", ["hit"]);
  });

  it("lets the chat model decide every hit when there is no Jev key", async () => {
    const m = models({ chatAssign: { choice: "s2" } });
    const d = await decide("hit", [cand("s1"), cand("s2")], m.all);
    expect(d).toMatchObject({ kind: "attach", score: null, decidedBy: "chat", rejudged: false });
    expect(d.kind === "attach" && d.candidate.signalId).toBe("sig-s2");
  });

  it("uses the chat model's new signal and checks it against every shortlisted anchor", async () => {
    const m = models({ chatAssign: { choice: "none", newSignal: NEW } });
    const d = await decide("hit", [cand("s1"), cand("s2")], m.all);
    expect(d).toMatchObject({ kind: "create", validated: true, decidedBy: "chat" });
    expect(m.chat.write).not.toHaveBeenCalled();
    expect(m.chat.validate).toHaveBeenCalledWith("covers new", "", [
      "hit",
      "example s1",
      "example s2",
    ]);
  });

  it("asks the writer when the chat model gives none without a usable signal, or an unknown id", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const choice of ["none", "s9"]) {
      const m = models({ chatAssign: { choice, newSignal: null } });
      const d = await decide("hit", [cand("s1")], m.all);
      expect(d.kind).toBe("create");
      expect(m.chat.write).toHaveBeenCalledOnce();
    }
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("flags criteria that swallow a shortlisted anchor or miss the hit", async () => {
    const swallow = models({
      chatAssign: { choice: "none", newSignal: NEW },
      accepted: [true, true],
    });
    expect(await decide("hit", [cand("s1")], swallow.all)).toMatchObject({ validated: false });
    const miss = models({
      chatAssign: { choice: "none", newSignal: NEW },
      accepted: [false, false],
    });
    expect(await decide("hit", [cand("s1")], miss.all)).toMatchObject({ validated: false });
  });

  it("keeps a confident Jev answer and records its probability", async () => {
    const m = models({ jev: { choice: "s1", p: 0.95 } });
    const d = await decide("hit", [cand("s1"), cand("s2")], m.all);
    expect(d).toMatchObject({ kind: "attach", score: 0.95, decidedBy: "jev", rejudged: false });
    expect(m.chat.assign).not.toHaveBeenCalled();
  });

  it("accepts Jev at exactly the threshold", async () => {
    const m = models({ jev: { choice: "s1", p: 0.9 } });
    expect(await decide("hit", [cand("s1")], m.all)).toMatchObject({ decidedBy: "jev" });
  });

  it("writes a new signal on a confident Jev none and validates it with Jev", async () => {
    const m = models({ jev: { choice: "none", p: 0.97 } });
    const d = await decide("hit", [cand("s1")], m.all);
    expect(d).toMatchObject({ kind: "create", decidedBy: "jev", validated: true });
    expect(m.chat.write).toHaveBeenCalledOnce();
    expect(m.jev!.validate).toHaveBeenCalledOnce();
    expect(m.chat.validate).not.toHaveBeenCalled();
  });

  it("has the chat model re-judge an unsure Jev answer, and the chat answer wins", async () => {
    const m = models({ jev: { choice: "s1", p: 0.6 }, chatAssign: { choice: "s2" } });
    const d = await decide("hit", [cand("s1"), cand("s2")], m.all);
    expect(d).toMatchObject({ kind: "attach", decidedBy: "chat", rejudged: true, score: null });
    expect(d.kind === "attach" && d.candidate.label).toBe("s2");
  });
});
