import { SKILL_LIBRARY, type UpdateSkill } from "./library.ts";

export type { SkillCondition, UpdateSkill } from "./library.ts";

const BY_NAME: ReadonlyMap<string, UpdateSkill> = new Map(SKILL_LIBRARY.map((s) => [s.name, s]));

export const UPDATE_SKILL_NAMES: readonly string[] = SKILL_LIBRARY.map((s) => s.name);

/** The skills that run on every update and cannot be left out. */
export const REQUIRED_SKILL_NAMES: readonly string[] = SKILL_LIBRARY.filter((s) => s.required).map(
  (s) => s.name,
);

/**
 * The only way anything reads a skill. A later per-project override layer goes
 * behind this function without changing its callers.
 */
export function loadSkill(name: string): UpdateSkill {
  const found = BY_NAME.get(name);
  if (!found) throw new Error(`Unknown update skill "${name}".`);
  return found;
}

export function listSkills(): UpdateSkill[] {
  return SKILL_LIBRARY.map((s) => loadSkill(s.name));
}

/** The skills a run uses: the required ones always, the rest when their condition holds. */
export function skillsForRun(options: {
  frequency: "daily" | "weekly";
  codeChangesEnabled: boolean;
}): UpdateSkill[] {
  return listSkills().filter((s) => {
    if (s.required || s.when === "always") return true;
    if (s.when === "weekly") return options.frequency === "weekly";
    return options.codeChangesEnabled;
  });
}
