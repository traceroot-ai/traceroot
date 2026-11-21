/** The spellings a worker on/off switch reads as on. */
export const TRUTHY_ENV_VALUES: readonly string[] = ["true", "1", "yes", "on"];

/** Trimmed and case-insensitive; anything else, unset included, is not on. */
export function isTruthyEnvValue(value: string | undefined): boolean {
  return TRUTHY_ENV_VALUES.includes((value ?? "").trim().toLowerCase());
}
