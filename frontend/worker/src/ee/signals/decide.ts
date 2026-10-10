import { JEV_ACCEPT_PROBABILITY } from "./config.js";
import type { AssignmentModels, Candidate, SignalText } from "./types.js";

export type Decision =
  | {
      kind: "attach";
      candidate: Candidate;
      /** Jev's probability when Jev decided; null when the chat model did. */
      score: number | null;
      decidedBy: "jev" | "chat";
      rejudged: boolean;
      reason: string;
    }
  | {
      kind: "create";
      signal: SignalText;
      /** Whether the criteria accept this hit and reject every shortlisted anchor. */
      validated: boolean;
      decidedBy: "jev" | "chat" | "empty";
      rejudged: boolean;
      reason: string;
    };

/**
 * Decide which shortlisted signal a hit joins, or write a new one.
 *
 * With a Jev key, Jev answers first and stands at or above
 * JEV_ACCEPT_PROBABILITY; below it the chat model re-judges and its answer
 * wins. Without one, the chat model decides every hit. A new signal's criteria
 * must accept this hit and reject each shortlisted anchor; a failed check still
 * creates the signal, reported as `validated: false`.
 */
export async function decide(
  material: string,
  candidates: readonly Candidate[],
  models: AssignmentModels,
): Promise<Decision> {
  if (candidates.length === 0) {
    const signal = await models.chat.write(material, candidates);
    const validated = await validate(models, signal, material, candidates);
    return { kind: "create", signal, validated, decidedBy: "empty", rejudged: false, reason: "" };
  }

  let rejudged = false;
  if (models.jev) {
    const answer = await models.jev.assign(material, candidates);
    const probability = answer.probabilities[answer.choice] ?? 0;
    const reason = `jev ${answer.choice} p=${probability.toFixed(2)}`;
    if (probability >= JEV_ACCEPT_PROBABILITY) {
      const candidate = candidates.find((c) => c.label === answer.choice);
      if (candidate) {
        return {
          kind: "attach",
          candidate,
          score: probability,
          decidedBy: "jev",
          rejudged,
          reason,
        };
      }
      const signal = await models.chat.write(material, candidates);
      const validated = await validate(models, signal, material, candidates);
      return { kind: "create", signal, validated, decidedBy: "jev", rejudged, reason };
    }
    rejudged = true;
  }

  const answer = await models.chat.assign(material, candidates);
  const candidate = candidates.find((c) => c.label === answer.choice);
  if (candidate) {
    return {
      kind: "attach",
      candidate,
      score: null,
      decidedBy: "chat",
      rejudged,
      reason: answer.reason,
    };
  }
  if (answer.choice !== "none") {
    console.warn(
      `[Signals] assignment answered unknown candidate "${answer.choice}"; treating as none`,
    );
  }
  const signal = answer.newSignal ?? (await models.chat.write(material, candidates));
  const validated = await validate(models, signal, material, candidates);
  return { kind: "create", signal, validated, decidedBy: "chat", rejudged, reason: answer.reason };
}

async function validate(
  models: AssignmentModels,
  signal: SignalText,
  material: string,
  candidates: readonly Candidate[],
): Promise<boolean> {
  const texts = [material, ...candidates.map((c) => c.example)];
  const validator = models.jev ?? models.chat;
  const accepted = await validator.validate(signal.covers, signal.excludes, texts);
  return accepted[0] === true && !accepted.slice(1).some(Boolean);
}
