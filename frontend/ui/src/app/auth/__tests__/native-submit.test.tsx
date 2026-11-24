// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";

// The HTML the server sends, before React takes over the page. A submit in that
// window is the browser's own: a form without a method sends its fields in the
// address (GET), so every auth form must post instead.

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

/** Each form's opening tag and the named fields inside it, as served. */
function forms(html: string) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return [...doc.querySelectorAll("form")].map((form) => ({
    method: form.getAttribute("method"),
    action: form.getAttribute("action"),
    fields: [...form.querySelectorAll("input[name]")].map((i) => i.getAttribute("name")),
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
  it("posts, so nothing typed before the page is ready goes into the address", () => {
    const served = forms(renderToString(page()));
    expect(served.length).toBeGreaterThan(0);
    for (const form of served) {
      expect(form.method).toBe("post");
      expect(form.action).toBeNull();
    }
    const fields = served.flatMap((f) => f.fields);
    for (const name of sensitive) expect(fields).toContain(name);
  });
});
