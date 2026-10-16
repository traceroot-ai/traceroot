"use client";

type AccountLineProps = {
  email: string | null;
  pending: boolean;
  onSwitchAccount: () => void;
};

/**
 * Which account the page is about, and the way out of it.
 *
 * Shared rather than page-local because /device and /onboarding are consecutive
 * screens in one terminal sign-in run and neither renders the app shell (see
 * lib/chromeless-routes), so the user menu that carries sign-out everywhere else
 * in the app is on neither of them. Being signed in as the wrong account is the
 * likeliest reason an account the CLI cannot use is looking at either screen —
 * better-auth has no separate social sign-up, so the Google button answers for
 * any address already linked to that identity — and the two screens answering
 * that differently is how a user ends up stranded on the one with no answer.
 *
 * Returning to the same screen afterwards is the caller's job: only it knows
 * what its own URL has to carry — a `user_code`, a `callbackUrl` — for the run
 * to survive the round trip through sign-in.
 */
export function AccountLine({ email, pending, onSwitchAccount }: AccountLineProps) {
  if (!email) {
    return null;
  }
  return (
    <div className="space-y-0.5 text-[12px] text-muted-foreground">
      <p>as {email}</p>
      <button
        type="button"
        onClick={onSwitchAccount}
        disabled={pending}
        className="underline hover:text-foreground disabled:opacity-50"
      >
        Not you? Sign out
      </button>
    </div>
  );
}
