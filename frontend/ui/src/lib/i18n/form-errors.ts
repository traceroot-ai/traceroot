import type { MessageKey } from "./messages/en";
import type { Translate } from "./translate";

// Form schemas are defined once at module load, before any language is known, so they carry
// English messages. This maps those messages to keys when they are shown. A message that is not
// listed (a server error, an email-policy reason) is shown as it arrived.
const FORM_ERROR_KEYS: Record<string, MessageKey> = {
  "Invalid email": "auth.errorInvalidEmail",
  "Password is required": "auth.errorPasswordRequired",
  "Name is required": "auth.errorNameRequired",
  "Password must be at least 8 characters": "auth.errorPasswordLength",
  "Passwords don't match": "auth.errorPasswordMismatch",
  "Invalid credentials": "auth.errorInvalidCredentials",
  "An unexpected error occurred": "auth.errorUnexpected",
  "Failed to create account": "auth.errorCreateFailed",
  "Could not start sign-in. Please try again.": "auth.errorStartFailed",
};

export function translateFormError(t: Translate, message: string | null | undefined) {
  if (!message) return message ?? null;
  const key = FORM_ERROR_KEYS[message];
  return key ? t(key) : message;
}
