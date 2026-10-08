import { describe, expect, it } from "vitest";
import * as unsub from "../lib/email/unsubscribe.ts";

const secrets = ["current-secret-0123456789", "previous-secret-9876543210"];
const signed = unsub.signUnsubscribeToken("a@x.io", secrets);
const tampered = signed.slice(0, -1) + (signed.endsWith("A") ? "B" : "A");

describe("unsubscribe token", () => {
  it("round-trips the lowercase address, verifying through a previous (comma-separated) secret", () => {
    const env = { TRACEROOT_EMAIL_TOKEN_SECRET: " new , old ," } as NodeJS.ProcessEnv;
    expect(unsub.unsubscribeSecrets(env)).toEqual(["new", "old"]);
    const token = unsub.signUnsubscribeToken("A@X.io", secrets);
    expect(unsub.verifyUnsubscribeToken(token, secrets)).toEqual({ valid: true, email: "a@x.io" });
    const old = unsub.signUnsubscribeToken("a@x.io", [secrets[1]]);
    expect(unsub.verifyUnsubscribeToken(old, secrets).valid).toBe(true);
  });

  it.each(["", "no-dot", "a.b.c", ".", "x.", "%%%.%%%", tampered])(
    "treats %j as invalid",
    (bad) => {
      expect(unsub.verifyUnsubscribeToken(bad, secrets)).toEqual({ valid: false });
    },
  );
});

describe("unsubscribeHeaders", () => {
  it("emits the mailto and https pair plus the one-click marker", () => {
    expect(unsub.UNSUBSCRIBE_PATH).toBe("/api/email/unsubscribe");
    const url = `https://app.traceroot.ai${unsub.UNSUBSCRIBE_PATH}?t=abc.def`;
    expect(unsub.unsubscribeHeaders({ url, mailto: "lucas@traceroot.ai" })).toEqual({
      "List-Unsubscribe": `<mailto:lucas@traceroot.ai?subject=unsubscribe>, <${url}>`,
      "List-Unsubscribe-Post": unsub.ONE_CLICK_UNSUBSCRIBE_BODY,
    });
  });
});
