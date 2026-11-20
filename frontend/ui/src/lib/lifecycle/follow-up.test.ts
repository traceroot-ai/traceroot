import { describe, expect, it } from "vitest";
import { decideFollowUp, isInvitedOnly, type Campaign, type FollowUpFacts } from "./follow-up";

const DAY = 24 * 60 * 60 * 1000;
const RUN_EVERY = 15 * 60 * 1000;
const SIGNED_UP = new Date("2026-12-01T09:00:00Z");
const day = (n: number) => new Date(SIGNED_UP.getTime() + n * DAY);

function facts(overrides: Partial<FollowUpFacts> = {}): FollowUpFacts {
  return {
    now: SIGNED_UP,
    isCloud: true,
    lifecycleStartAt: new Date("2026-11-30T00:00:00Z"),
    signedUpAt: SIGNED_UP,
    paused: false,
    unsubscribed: false,
    invitedOnly: false,
    firstTraceAt: null,
    githubConnected: false,
    slackConnected: false,
    hasRunEval: false,
    sends: [{ campaign: "welcome", at: SIGNED_UP }],
    ...overrides,
  };
}

/**
 * Runs the job every 15 minutes for 30 days, sending whatever is decided, and
 * answers which emails went out on which day after sign-up.
 */
function simulate(person: {
  firstTraceDay?: number;
  connectedDay?: number;
  evalDay?: number;
}): string[] {
  const sends: { campaign: Campaign; at: Date }[] = [{ campaign: "welcome", at: SIGNED_UP }];
  for (let t = SIGNED_UP.getTime(); t <= day(30).getTime(); t += RUN_EVERY) {
    const now = new Date(t);
    const at = (d?: number) => d !== undefined && now >= day(d);
    const decision = decideFollowUp(
      facts({
        now,
        firstTraceAt: at(person.firstTraceDay) ? day(person.firstTraceDay!) : null,
        githubConnected: at(person.connectedDay),
        slackConnected: at(person.connectedDay),
        hasRunEval: at(person.evalDay),
        sends,
      }),
    );
    if (decision.send) sends.push({ campaign: decision.send, at: now });
  }
  return sends.map((s) => `day ${(s.at.getTime() - SIGNED_UP.getTime()) / DAY}: ${s.campaign}`);
}

describe("the four examples (sign-up day is day 0)", () => {
  it("set up on day 1", () => {
    expect(simulate({ firstTraceDay: 1 })).toEqual([
      "day 0: welcome",
      "day 8: connect_slack_github",
      "day 15: first_eval",
    ]);
  });

  it("set up on day 4", () => {
    expect(simulate({ firstTraceDay: 4 })).toEqual([
      "day 0: welcome",
      "day 3: setup_help",
      "day 11: connect_slack_github",
      "day 18: first_eval",
    ]);
  });

  it("set up on day 8", () => {
    expect(simulate({ firstTraceDay: 8 })).toEqual([
      "day 0: welcome",
      "day 3: setup_help",
      "day 7: last_note",
      "day 15: connect_slack_github",
      "day 22: first_eval",
    ]);
  });

  it("never set up", () => {
    expect(simulate({})).toEqual(["day 0: welcome", "day 3: setup_help", "day 7: last_note"]);
  });
});

describe("what is skipped", () => {
  it("drops Slack and GitHub once both are connected, and First eval once an eval has run", () => {
    expect(simulate({ firstTraceDay: 1, connectedDay: 5, evalDay: 10 })).toEqual([
      "day 0: welcome",
    ]);
  });

  it("still sends Slack and GitHub when only one is connected", () => {
    expect(
      decideFollowUp(facts({ now: day(8), firstTraceAt: day(1), githubConnected: true })),
    ).toEqual({ send: "connect_slack_github" });
  });

  it("does not nudge to set up someone with a trace", () => {
    expect(decideFollowUp(facts({ now: day(3), firstTraceAt: day(2) }))).toEqual({
      send: null,
      reason: "nothing_due",
    });
  });

  it("does not send the same email twice", () => {
    expect(
      decideFollowUp(
        facts({
          now: day(5),
          sends: [
            { campaign: "welcome", at: day(0) },
            { campaign: "setup_help", at: day(3) },
          ],
        }),
      ),
    ).toEqual({ send: null, reason: "nothing_due" });
  });
});

describe("who gets no follow-ups", () => {
  it.each<[string, Partial<FollowUpFacts>, string]>([
    ["self-hosted", { isCloud: false }, "self_hosted"],
    ["signed up before the start", { lifecycleStartAt: day(1) }, "before_start"],
    ["no start set", { lifecycleStartAt: null }, "before_start"],
    ["paused", { paused: true }, "paused"],
    ["unsubscribed", { unsubscribed: true }, "unsubscribed"],
    ["invited by a colleague", { invitedOnly: true }, "invited_only"],
    ["never sent the welcome email", { sends: [] }, "no_welcome"],
  ])("%s", (_who, overrides, reason) => {
    expect(decideFollowUp(facts({ now: day(3), ...overrides }))).toEqual({ send: null, reason });
  });

  it("someone paused part way gets nothing more, and continues once resumed", () => {
    const paused = facts({
      now: day(7),
      paused: true,
      sends: [
        { campaign: "welcome", at: day(0) },
        { campaign: "setup_help", at: day(3) },
      ],
    });
    expect(decideFollowUp(paused).send).toBeNull();
    expect(decideFollowUp({ ...paused, paused: false })).toEqual({ send: "last_note" });
  });
});

describe("frequency limits", () => {
  it("waits 48 hours after any email, then sends while the email is still valid", () => {
    // Set up on day 1; the welcome email went out (late) 47 hours before Slack and GitHub fell due.
    const blocked = facts({
      now: day(8),
      firstTraceAt: day(1),
      sends: [{ campaign: "welcome", at: new Date(day(8).getTime() - 47 * 60 * 60 * 1000) }],
    });
    expect(decideFollowUp(blocked)).toEqual({ send: null, reason: "frequency_limit" });
    expect(
      decideFollowUp({ ...blocked, now: new Date(day(8).getTime() + 60 * 60 * 1000) }),
    ).toEqual({ send: "connect_slack_github" });
  });

  it("sends no more than 2 in 7 days, and sends once one has left the window", () => {
    // Two emails on days 2 and 5, both more than 48 hours before day 8.
    const sends = [
      { campaign: "welcome" as const, at: day(2) },
      { campaign: "setup_help" as const, at: day(5) },
    ];
    const due = facts({ now: day(8), firstTraceAt: day(1), sends });
    expect(decideFollowUp(due)).toEqual({ send: null, reason: "frequency_limit" });
    // Exactly 7 days after the first, it has left the window.
    expect(decideFollowUp({ ...due, now: day(9) })).toEqual({ send: "connect_slack_github" });
  });

  it("sends no more than 5 in 30 days", () => {
    const sends = [0, 3, 6, 9, 12].map((d, i) => ({
      campaign: (
        ["welcome", "setup_help", "last_note", "connect_slack_github", "welcome"] as const
      )[i],
      at: day(d),
    }));
    expect(decideFollowUp(facts({ now: day(15), firstTraceAt: day(1), sends }))).toEqual({
      send: null,
      reason: "frequency_limit",
    });
  });

  it("drops an email held back past its expiry", () => {
    // Setup help is due on day 3 and expires on day 6.
    const sends = [{ campaign: "welcome" as const, at: new Date(day(5).getTime()) }];
    expect(decideFollowUp(facts({ now: day(6), sends }))).toEqual({
      send: null,
      reason: "nothing_due",
    });
    expect(decideFollowUp(facts({ now: new Date(day(6).getTime() - 1), sends }))).toEqual({
      send: null,
      reason: "frequency_limit",
    });
  });
});

describe("isInvitedOnly", () => {
  const demo = { isDemo: true, createdBy: null };
  it.each<[string, { isDemo: boolean; createdBy: string | null }[], boolean]>([
    ["only in a colleague's workspace", [demo, { isDemo: false, createdBy: "u2" }], true],
    [
      "created one of their workspaces",
      [
        { isDemo: false, createdBy: "u2" },
        { isDemo: false, createdBy: "u1" },
      ],
      false,
    ],
    ["in no workspace but the demo", [demo], false],
    ["in no workspace", [], false],
    ["in an older workspace with no recorded creator", [{ isDemo: false, createdBy: null }], true],
  ])("%s → %s", (_who, workspaces, invited) => {
    expect(isInvitedOnly("u1", workspaces)).toBe(invited);
  });
});
