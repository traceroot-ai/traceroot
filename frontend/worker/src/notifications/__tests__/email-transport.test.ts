import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendMail = vi.fn();
const createTransportSpy = vi.fn((_opts: unknown) => ({ sendMail }));

vi.mock("nodemailer", () => ({
  default: { createTransport: (opts: unknown) => createTransportSpy(opts) },
}));

const params = {
  to: ["admin@example.com"],
  kind: "warning" as const,
  meter: "events" as const,
  workspaceId: "ws-1",
  workspaceName: "Acme",
  used: 40_000,
  cap: 50_000,
};

async function transportOptsFor(smtpUrl: string): Promise<Record<string, unknown>> {
  vi.resetModules();
  createTransportSpy.mockClear();
  sendMail.mockResolvedValue(undefined);
  process.env.TRACEROOT_SMTP_URL = smtpUrl;
  const { sendUsageQuotaEmail } = await import("../email.js");
  await sendUsageQuotaEmail(params);
  expect(createTransportSpy).toHaveBeenCalledTimes(1);
  return createTransportSpy.mock.calls[0][0] as Record<string, unknown>;
}

describe("createTransport URL-scheme handling", () => {
  beforeEach(() => {
    sendMail.mockReset();
  });

  afterEach(() => {
    delete process.env.TRACEROOT_SMTP_URL;
  });

  it("smtps:// without a port defaults to implicit TLS on 465", async () => {
    const opts = await transportOptsFor("smtps://user:pass@mail.example.com");
    expect(opts.port).toBe(465);
    expect(opts.secure).toBe(true);
  });

  it("smtp:// without a port defaults to STARTTLS-capable 587", async () => {
    const opts = await transportOptsFor("smtp://user:pass@mail.example.com");
    expect(opts.port).toBe(587);
    expect(opts.secure).toBe(false);
  });

  it("smtp:// with explicit port 465 keeps implicit TLS (back-compat)", async () => {
    const opts = await transportOptsFor("smtp://user:pass@mail.example.com:465");
    expect(opts.port).toBe(465);
    expect(opts.secure).toBe(true);
  });

  it("an explicit non-465 port wins and stays plaintext for smtp://", async () => {
    const opts = await transportOptsFor("smtp://user:pass@localhost:1025");
    expect(opts.port).toBe(1025);
    expect(opts.secure).toBe(false);
  });

  it("smtps:// with an explicit port keeps implicit TLS on that port", async () => {
    const opts = await transportOptsFor("smtps://user:pass@mail.example.com:2465");
    expect(opts.port).toBe(2465);
    expect(opts.secure).toBe(true);
  });

  it("credentials are URL-decoded", async () => {
    const opts = await transportOptsFor("smtps://res%2Bend:p%40ss@mail.example.com");
    expect(opts.auth).toEqual({ user: "res+end", pass: "p@ss" });
  });
});
