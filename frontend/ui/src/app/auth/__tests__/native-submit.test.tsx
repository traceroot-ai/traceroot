// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { cleanup, render } from "@testing-library/react";

// The HTML the server sends, before React takes over the page. A submit in that
// window would be the browser's own, which no handler on the page receives: a
// form without a method even sends its fields in the address. So every auth
// form posts, and its submit button stays disabled until the page is ready,
// which also stops Enter from submitting it.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams("token=placeholder-token"),
}));
vi.mock("@/lib/auth-client", () => ({
  authClient: {
    signIn: { email: vi.fn(), social: vi.fn() },
    signUp: { email: vi.fn() },
    requestPasswordReset: vi.fn(),
    resetPassword: vi.fn(),
  },
}));
vi.mock("@/env", () => ({ env: {} }));

import { ForgotPasswordClient } from "../forgot-password/forgot-password-client";
import { ResetPasswordClient } from "../reset-password/reset-password-client";
import { SignInClient } from "../sign-in/sign-in-client";
import { SignUpClient } from "../sign-up/sign-up-client";

// Unmounts after every test, passed or failed, so one test's page never
// reaches the next.
afterEach(cleanup);

/** Each form's opening tag and the named fields inside it, as served. */
function forms(html: string) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return [...doc.querySelectorAll("form")].map((form) => ({
    method: form.getAttribute("method"),
    action: form.getAttribute("action"),
    fields: [...form.querySelectorAll("input[name]")].map((i) => i.getAttribute("name")),
    // Buttons that submit the form: without a type attribute a button submits.
    submits: [...form.querySelectorAll("button")]
      .filter((b) => (b.getAttribute("type") ?? "submit") === "submit")
      .map((b) => b.hasAttribute("disabled")),
  }));
}

describe.each([
  [
    "sign-in",
    () => <SignInClient socialProviders={["google", "agentid"]} />,
    ["email", "password"],
  ],
  [
    "sign-up",
    () => <SignUpClient socialProviders={["google", "agentid"]} emailDomainPolicyEnabled />,
    ["email", "password"],
  ],
  ["forgot password", () => <ForgotPasswordClient />, ["email"]],
  ["reset password", () => <ResetPasswordClient />, ["password"]],
])("the %s form, as served", (_name, page, sensitive) => {
  it("posts, and cannot be submitted before the page is ready", () => {
    const served = forms(renderToString(page()));
    expect(served.length).toBeGreaterThan(0);
    for (const form of served) {
      expect(form.method).toBe("post");
      expect(form.action).toBeNull();
      // One submit button, disabled as served: no click or Enter can submit.
      expect(form.submits).toEqual([true]);
    }
    const fields = served.flatMap((f) => f.fields);
    for (const name of sensitive) expect(fields).toContain(name);
  });

  it("enables its submit button once the page is ready", () => {
    render(page());
    const forms = [...document.querySelectorAll("form")];
    expect(forms.length).toBeGreaterThan(0);
    for (const form of forms) {
      const submit = form.querySelector('button[type="submit"]') as HTMLButtonElement;
      expect(submit.disabled).toBe(false);
    }
  });
});
