// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";

// The mocked `device` call must carry its `.approve`/`.deny` sub-mocks from
// the moment it's created — vi.mock's factory below runs at import time
// (before any later top-level statement in this file), so reassigning
// `mocks.device` afterwards would be invisible to it.
const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  useSession: vi.fn(),
  signOut: vi.fn(),
  device: Object.assign(vi.fn(), { approve: vi.fn(), deny: vi.fn() }),
  // One workspace with a project in it by default: these tests are about the
  // consent screen, and consent is only reached by an account that has
  // somewhere for traces to go. The empty cases have tests of their own below.
  getWorkspaces: vi.fn(async () => [READY_WORKSPACE]),
  // Spies, not stubs: the page ends at approval, and these prove it reads no
  // project or trace list on the way there or after.
  getProjects: vi.fn(async () => []),
  getTraces: vi.fn(async () => ({ data: [], meta: { page: 0, limit: 0, total: 0 } })),
}));

// Shaped like GET /api/workspaces answers it (see app/api/workspaces/route.ts):
// `role` and `project_count` are what the gate reads, so a stub without them
// would prove nothing about the real payload.
const READY_WORKSPACE = { id: "ws-1", name: "Acme", role: "ADMIN", project_count: 1 };
const EMPTY_WORKSPACE = { id: "ws-empty", name: "Acme", role: "ADMIN", project_count: 0 };

// What `authClient.signOut()` really answers with: an envelope, success or not.
// A refusal is resolved, not thrown — a 429 arrives this way — so a handler that
// reads only a rejection treats it as a cleared session.
const SIGNED_OUT = { data: { success: true }, error: null };
const SIGN_OUT_REFUSED = {
  data: null,
  error: { status: 429, statusText: "Too Many Requests", message: "Too many requests" },
};

let searchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
  useSearchParams: () => searchParams,
}));

vi.mock("@/lib/api/workspaces", () => ({
  getWorkspaces: () => mocks.getWorkspaces(),
}));

vi.mock("@/lib/api/projects", () => ({
  getProjects: () => mocks.getProjects(),
}));

vi.mock("@/lib/api/traces", () => ({
  getTraces: () => mocks.getTraces(),
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    useSession: () => mocks.useSession(),
    signOut: (...args: unknown[]) => mocks.signOut(...args),
    device: mocks.device,
  },
}));

import { DeviceClient } from "../device-client";

function setParams(params: Record<string, string>) {
  searchParams = new URLSearchParams(params);
}

function signedIn(email = "kai@example.com") {
  mocks.useSession.mockReturnValue({
    data: { user: { email, name: "Kai" } },
    isPending: false,
  });
}

function signedOut() {
  mocks.useSession.mockReturnValue({ data: null, isPending: false });
}

afterEach(() => {
  cleanup();
  mocks.push.mockReset();
  mocks.useSession.mockReset();
  mocks.device.mockReset();
  mocks.device.approve.mockReset();
  mocks.getWorkspaces.mockReset();
  mocks.getWorkspaces.mockResolvedValue([READY_WORKSPACE]);
  mocks.getProjects.mockClear();
  mocks.getTraces.mockClear();
  mocks.device.deny.mockReset();
  mocks.signOut.mockReset();
  searchParams = new URLSearchParams();
});

describe("DeviceClient", () => {
  it("auto-redirects to sign-in with the code in callbackUrl when signed out (no Continue)", async () => {
    setParams({ user_code: "abcd1234" });
    signedOut();

    render(<DeviceClient />);

    // A code in the URL advances on its own — no manual Continue to reach login.
    await waitFor(() => expect(mocks.push).toHaveBeenCalled());
    const target = mocks.push.mock.calls[0][0] as string;
    expect(target).toBe(
      `/auth/sign-in?callbackUrl=${encodeURIComponent("/device?user_code=ABCD1234")}`,
    );
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
  });

  it("carries client_id through the signed-out redirect so consent still names the client", async () => {
    setParams({ user_code: "abcd1234", client_id: "traceroot-cli" });
    signedOut();

    render(<DeviceClient />);

    await waitFor(() => expect(mocks.push).toHaveBeenCalled());
    const target = mocks.push.mock.calls[0][0] as string;
    expect(target).toBe(
      `/auth/sign-in?callbackUrl=${encodeURIComponent("/device?user_code=ABCD1234&client_id=traceroot-cli")}`,
    );
  });

  it("carries the code and client through the signed-out redirect", async () => {
    // Both must survive the sign-in round trip, or the return lands on the code
    // entry form instead of consent. A new account reaches onboarding on the way
    // back — sign-up routes itself through it and hands this URL on — so there
    // is nothing else for this redirect to carry.
    setParams({ user_code: "abcd1234", client_id: "traceroot-cli" });
    signedOut();

    render(<DeviceClient />);

    await waitFor(() => expect(mocks.push).toHaveBeenCalled());
    const target = mocks.push.mock.calls[0][0] as string;
    expect(target).toBe(
      `/auth/sign-in?callbackUrl=${encodeURIComponent(
        "/device?user_code=ABCD1234&client_id=traceroot-cli",
      )}`,
    );
  });

  it("auto-advances to consent when signed in with a code in the URL (no Continue)", async () => {
    setParams({ user_code: "abcd1234", client_id: "traceroot-cli" });
    signedIn("kai@example.com");
    mocks.device.mockResolvedValue({
      data: { user_code: "ABCD1234", status: "pending" },
      error: null,
    });

    render(<DeviceClient />);

    await waitFor(() => expect(screen.getByText("TraceRoot CLI")).toBeDefined());
    expect(screen.getByText("as kai@example.com")).toBeDefined();
    expect(screen.getByText("ABCD-1234")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
  });

  it("withholds approval from an account with no workspace and offers onboarding", async () => {
    // The terminal must not be released to an account that owns nothing: the
    // CLI's next move is to resolve a workspace and a project, and it can do
    // neither. Checked here rather than on the route in, because this page
    // hands a signed-out visitor to sign-IN and `signIn.social` creates the
    // account on first use — clicking Google there is the default new-account
    // path and it used to arrive back here owning nothing.
    setParams({ user_code: "abcd1234", client_id: "traceroot-cli" });
    signedIn("new@example.com");
    mocks.getWorkspaces.mockResolvedValue([]);

    render(<DeviceClient />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Continue setup" })).toBeDefined(),
    );
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    // Nothing is navigated for them: the screen is reached without a redirect,
    // which is what leaves Deny reachable (see the denial test below).
    expect(mocks.push).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Continue setup" }));

    // The code is normalised on the way in, so the round trip carries the
    // canonical form rather than whatever case the URL arrived in.
    expect(mocks.push).toHaveBeenCalledWith(
      `/onboarding?callbackUrl=${encodeURIComponent("/device?user_code=ABCD1234&client_id=traceroot-cli")}`,
    );
  });

  it("can still deny from the setup screen, so an unsolicited request is refusable", async () => {
    // The person who did not start this flow is exactly the person who owns
    // nothing yet. Gating approval on setup must not take their refusal away
    // and leave the request pending until it expires.
    setParams({ user_code: "abcd1234", client_id: "traceroot-cli" });
    signedIn("new@example.com");
    mocks.getWorkspaces.mockResolvedValue([]);
    mocks.device.mockResolvedValue({
      data: { user_code: "ABCD1234", status: "pending" },
      error: null,
    });
    mocks.device.deny.mockResolvedValue({ data: { success: true }, error: null });

    render(<DeviceClient />);
    await waitFor(() => screen.getByRole("button", { name: "Deny" }));
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));

    await waitFor(() => expect(screen.getByText("Denied")).toBeDefined());
    expect(mocks.device.deny).toHaveBeenCalledWith({ userCode: "ABCD1234" });
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("sends an account whose workspace has no project to project-only onboarding", async () => {
    // A workspace is not what the CLI needs — a project is. An account that
    // deleted its last project owns a workspace and still has nowhere for
    // traces to go, so approving would hand the terminal the same dead end the
    // workspace check was added to prevent. `?workspaceId=` asks for the one
    // thing that is missing instead of a second workspace.
    setParams({ user_code: "abcd1234", client_id: "traceroot-cli" });
    signedIn("kai@example.com");
    mocks.getWorkspaces.mockResolvedValue([EMPTY_WORKSPACE]);

    render(<DeviceClient />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Continue setup" })).toBeDefined(),
    );
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Continue setup" }));

    expect(mocks.push).toHaveBeenCalledWith(
      `/onboarding?workspaceId=ws-empty&workspaceName=Acme&callbackUrl=${encodeURIComponent(
        "/device?user_code=ABCD1234&client_id=traceroot-cli",
      )}`,
    );
  });

  it("offers a workspace instead when the only empty one is read-only to this account", async () => {
    // Creating a project needs MEMBER or higher, so routing a VIEWER into
    // project-only onboarding would hand them a form whose submit is a 403.
    setParams({ user_code: "abcd1234", client_id: "traceroot-cli" });
    signedIn("viewer@example.com");
    mocks.getWorkspaces.mockResolvedValue([{ ...EMPTY_WORKSPACE, role: "VIEWER" }]);

    render(<DeviceClient />);

    await waitFor(() => screen.getByRole("button", { name: "Continue setup" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue setup" }));

    expect(mocks.push).toHaveBeenCalledWith(
      `/onboarding?callbackUrl=${encodeURIComponent("/device?user_code=ABCD1234&client_id=traceroot-cli")}`,
    );
  });

  it("reaches consent when any workspace the account belongs to has a project", async () => {
    // One usable project is the whole requirement; an empty workspace sitting
    // next to it is not a reason to stop.
    setParams({ user_code: "abcd1234", client_id: "traceroot-cli" });
    signedIn("kai@example.com");
    mocks.getWorkspaces.mockResolvedValue([EMPTY_WORKSPACE, READY_WORKSPACE]);

    render(<DeviceClient />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Approve" })).toBeDefined());
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("does not approve, or blame the code, when the workspace check fails", async () => {
    // Nothing is wrong with the code, so naming it would send the user back to
    // the CLI for a fresh one that fails here in exactly the same way.
    setParams({ user_code: "abcd1234", client_id: "traceroot-cli" });
    signedIn();
    mocks.getWorkspaces.mockRejectedValue(new Error("network"));

    render(<DeviceClient />);

    await waitFor(() => expect(screen.getByText(/Could not load/)).toBeDefined());
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(mocks.device.approve).not.toHaveBeenCalled();
  });

  it("shows the entry form for a bare visit with no code in the URL", () => {
    signedOut();

    render(<DeviceClient />);

    const input = screen.getByLabelText("Device code") as HTMLInputElement;
    expect(input.value).toBe("");
    expect(screen.getByRole("button", { name: "Continue" })).toBeDefined();
  });

  it("advances from a manually entered code when the URL has none", async () => {
    signedIn("kai@example.com");
    mocks.device.mockResolvedValue({
      data: { user_code: "ABCD1234", status: "pending" },
      error: null,
    });

    render(<DeviceClient />);
    const input = screen.getByLabelText("Device code");
    fireEvent.change(input, { target: { value: "abcd1234" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(screen.getByText("as kai@example.com")).toBeDefined());
    expect(screen.getByText("ABCD-1234")).toBeDefined();
  });

  it("falls back to a generic name for an unrecognized client id", async () => {
    setParams({ user_code: "abcd1234", client_id: "some-other-app" });
    signedIn();
    mocks.device.mockResolvedValue({
      data: { user_code: "ABCD1234", status: "pending" },
      error: null,
    });

    render(<DeviceClient />);

    await waitFor(() => expect(screen.getByText("A command-line application")).toBeDefined());
  });

  it("approves with the hyphen-stripped code and shows the success state", async () => {
    setParams({ user_code: "abcd1234" });
    signedIn();
    mocks.device.mockResolvedValue({
      data: { user_code: "ABCD1234", status: "pending" },
      error: null,
    });
    mocks.device.approve.mockResolvedValue({ data: { success: true }, error: null });

    render(<DeviceClient />);
    await waitFor(() => screen.getByRole("button", { name: "Approve" }));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => expect(screen.getByText("Device approved")).toBeDefined());
    expect(mocks.device.approve).toHaveBeenCalledWith({ userCode: "ABCD1234" });
  });

  it("ends at approval: says the window can close, reads no traces, opens nothing", async () => {
    // Approval is the last thing the browser does. A stale `next` on the URL —
    // a link opened from before this ordering changed — must not send the user
    // onward and create a second workspace behind the one that already exists.
    // Nor does the page wait on the run: the terminal reports how it went, so
    // nothing here polls for a trace or navigates to one.
    setParams({ user_code: "abcd1234", next: "/onboarding" });
    signedIn();
    mocks.device.mockResolvedValue({
      data: { user_code: "ABCD1234", status: "pending" },
      error: null,
    });
    mocks.device.approve.mockResolvedValue({ data: { success: true }, error: null });

    render(<DeviceClient />);
    await waitFor(() => screen.getByRole("button", { name: "Approve" }));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => expect(screen.getByText("Device approved")).toBeDefined());
    expect(screen.getByText("You can close this window now.")).toBeDefined();

    // Well past any polling interval or wait budget the page could have started.
    vi.useFakeTimers();
    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
      });
    } finally {
      vi.useRealTimers();
    }

    expect(mocks.getProjects).not.toHaveBeenCalled();
    expect(mocks.getTraces).not.toHaveBeenCalled();
    expect(screen.queryByText(/first trace/i)).toBeNull();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("denies and shows the denied state", async () => {
    setParams({ user_code: "abcd1234" });
    signedIn();
    mocks.device.mockResolvedValue({
      data: { user_code: "ABCD1234", status: "pending" },
      error: null,
    });
    mocks.device.deny.mockResolvedValue({ data: { success: true }, error: null });

    render(<DeviceClient />);
    await waitFor(() => screen.getByRole("button", { name: "Deny" }));
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));

    await waitFor(() => expect(screen.getByText("Denied")).toBeDefined());
    expect(mocks.device.deny).toHaveBeenCalledWith({ userCode: "ABCD1234" });
  });

  it("surfaces an error instead of success when approval is rejected (not the claiming session)", async () => {
    setParams({ user_code: "abcd1234" });
    signedIn();
    mocks.device.mockResolvedValue({
      data: { user_code: "ABCD1234", status: "pending" },
      error: null,
    });
    mocks.device.approve.mockResolvedValue({
      data: null,
      error: {
        error: "access_denied",
        error_description: "You are not authorized to approve this device authorization",
      },
    });

    render(<DeviceClient />);
    await waitFor(() => screen.getByRole("button", { name: "Approve" }));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() =>
      expect(
        screen.getByText(
          "This code was already opened by a different account and is locked to it. Go back to your terminal and run the login command again to get a fresh code.",
        ),
      ).toBeDefined(),
    );
    expect(screen.queryByText("Device approved")).toBeNull();
    // Terminal error: no looping "Try again" — the code is dead, they need a new one.
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("shows a mapped message for an expired code (surfaced when approving)", async () => {
    setParams({ user_code: "abcd1234" });
    signedIn();
    // The claim is deferred to the action, so the expired error appears on Approve.
    mocks.device.mockResolvedValue({
      data: null,
      error: { error: "expired_token", error_description: "User code has expired" },
    });

    render(<DeviceClient />);
    await waitFor(() => screen.getByRole("button", { name: "Approve" }));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() =>
      expect(
        screen.getByText(
          "This code has expired. Go back to your terminal and run the login command again.",
        ),
      ).toBeDefined(),
    );
  });

  it("shows a mapped message for an invalid code (surfaced when approving)", async () => {
    setParams({ user_code: "abcd1234" });
    signedIn();
    mocks.device.mockResolvedValue({
      data: null,
      error: { error: "invalid_request", error_description: "Invalid user code" },
    });

    render(<DeviceClient />);
    await waitFor(() => screen.getByRole("button", { name: "Approve" }));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() =>
      expect(
        screen.getByText(
          "That code doesn't match a pending request. Double-check it and try again.",
        ),
      ).toBeDefined(),
    );
  });

  it("shows an already-used message when the code has already been claimed (on approve)", async () => {
    setParams({ user_code: "abcd1234" });
    signedIn();
    mocks.device.mockResolvedValue({
      data: { user_code: "ABCD1234", status: "approved" },
      error: null,
    });

    render(<DeviceClient />);
    await waitFor(() => screen.getByRole("button", { name: "Approve" }));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => expect(screen.getByText("This code has already been used.")).toBeDefined());
  });

  it("shows an entry error instead of submitting when the code field is empty", () => {
    signedOut();

    render(<DeviceClient />);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(screen.getByText("Enter the code shown in your terminal.")).toBeDefined();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("surfaces an error instead of the denied state when denial is rejected", async () => {
    setParams({ user_code: "abcd1234" });
    signedIn();
    mocks.device.mockResolvedValue({
      data: { user_code: "ABCD1234", status: "pending" },
      error: null,
    });
    mocks.device.deny.mockResolvedValue({
      data: null,
      error: { error: "expired_token", error_description: "User code has expired" },
    });

    render(<DeviceClient />);
    await waitFor(() => screen.getByRole("button", { name: "Deny" }));
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));

    await waitFor(() =>
      expect(
        screen.getByText(
          "This code has expired. Go back to your terminal and run the login command again.",
        ),
      ).toBeDefined(),
    );
    expect(screen.queryByText("Denied")).toBeNull();
  });

  it("offers Try again for a mistyped code and returns to the entry form (on approve)", async () => {
    setParams({ user_code: "abcd1234" });
    signedIn();
    mocks.device.mockResolvedValue({
      data: null,
      error: { error: "invalid_request", error_description: "Invalid user code" },
    });

    render(<DeviceClient />);
    await waitFor(() => screen.getByRole("button", { name: "Approve" }));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => screen.getByRole("button", { name: "Try again" }));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    const input = screen.getByLabelText("Device code") as HTMLInputElement;
    expect(input.value).toBe("");
  });

  it("shows no Try again for an expired code (terminal — needs a fresh code, on approve)", async () => {
    setParams({ user_code: "abcd1234" });
    signedIn();
    mocks.device.mockResolvedValue({
      data: null,
      error: { error: "expired_token", error_description: "User code has expired" },
    });

    render(<DeviceClient />);
    await waitFor(() => screen.getByRole("button", { name: "Approve" }));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect(
        screen.getByText(
          "This code has expired. Go back to your terminal and run the login command again.",
        ),
      ).toBeDefined(),
    );
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("does not claim the code on load — no verify call until the user acts", async () => {
    setParams({ user_code: "abcd1234" });
    signedIn();

    render(<DeviceClient />);
    // Consent shows without a verify/claim round-trip...
    await waitFor(() => screen.getByRole("button", { name: "Approve" }));
    expect(mocks.device).not.toHaveBeenCalled();
  });

  it.each([
    ["is refused", () => mocks.signOut.mockResolvedValue(SIGN_OUT_REFUSED)],
    ["never completes", () => mocks.signOut.mockRejectedValue(new Error("offline"))],
  ])("says so and sends nobody to sign-in when the sign-out %s", async (_how, arrange) => {
    // A resolved-but-refused answer is how better-auth reports a rate limit, and
    // neither it nor a rejection was read: the code was cleared before the
    // sign-out, both screens are gated on the code, and the card rendered its
    // header over an empty body with nothing to click.
    setParams({ user_code: "abcd1234" });
    signedIn("wrong@example.com");
    arrange();

    render(<DeviceClient />);
    await waitFor(() => screen.getByText("as wrong@example.com"));
    fireEvent.click(screen.getByRole("button", { name: "Not you? Sign out" }));

    await waitFor(() => expect(screen.getByText(/Could not sign out/)).toBeDefined());
    // And something to click, where there used to be nothing.
    expect(screen.getByRole("button", { name: "Try again" })).toBeDefined();
    // The session is still live, so a sign-in would hand the browser straight
    // back here as the same account.
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("signs out and returns to sign-in carrying the code from the consent 'Not you?' action", async () => {
    setParams({ user_code: "abcd1234" });
    signedIn("wrong@example.com");
    mocks.signOut.mockResolvedValue(SIGNED_OUT);

    render(<DeviceClient />);
    await waitFor(() => screen.getByText("as wrong@example.com"));
    fireEvent.click(screen.getByRole("button", { name: "Not you? Sign out" }));

    await waitFor(() => expect(mocks.signOut).toHaveBeenCalled());
    // Code isn't claimed until the user acts, so it survives the account switch:
    // carry it back via callbackUrl so the new account lands on consent.
    expect(mocks.push).toHaveBeenCalledWith(
      `/auth/sign-in?callbackUrl=${encodeURIComponent("/device?user_code=ABCD1234")}`,
    );
  });
});
