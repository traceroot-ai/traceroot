import { beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.fn();

vi.mock("child_process", () => ({
  spawn: vi.fn(),
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

const {
  agentInstanceId,
  destroyAllExecutors,
  hasLegacySandboxName,
  inspectSandboxLabels,
  isSafeLabelValue,
  listLabeledSandboxIds,
  reconcileStaleSandboxes,
  removeSandboxContainer,
  sandboxContainerName,
  sandboxRunLabelArgs,
  SANDBOX_NAME_PREFIX,
  StartupGate,
} = await import("../sandbox-lifecycle.js");

type NodeCallback = (err: Error | null, result?: { stdout: string; stderr: string }) => void;

/** Route every execFile call through `handler` on its argv. */
function routeExecFile(handler: (argv: string[]) => string) {
  execFileMock.mockImplementation((...callArgs: unknown[]) => {
    const cb = callArgs[callArgs.length - 1] as NodeCallback;
    const argv = callArgs[1] as string[];
    try {
      cb(null, { stdout: handler(argv), stderr: "" });
    } catch (error) {
      cb(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

const STALE = "a".repeat(64);
const ACTIVE = "b".repeat(64);
const LEGACY = "c".repeat(64);

function inspectResponse(
  entries: Array<{ id: string; labels: Record<string, string>; name?: string }>,
) {
  return JSON.stringify(
    entries.map((entry) => ({
      Id: entry.id,
      // Docker inspect reports names with a leading slash; omitting the key
      // simulates a report with no usable name (fail closed below).
      ...(entry.name === undefined ? {} : { Name: entry.name }),
      Config: { Labels: entry.labels },
    })),
  );
}

beforeEach(() => {
  execFileMock.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("label values", () => {
  it("accepts cuid session ids and UUID owners", () => {
    expect(isSafeLabelValue("cm123abcXYZ")).toBe(true);
    expect(isSafeLabelValue("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
    expect(isSafeLabelValue("sess-abc_123.9")).toBe(true);
  });

  it("rejects shell metacharacters, spaces, and empty values", () => {
    expect(isSafeLabelValue("")).toBe(false);
    expect(isSafeLabelValue('s1" ; rm -rf /')).toBe(false);
    expect(isSafeLabelValue("a b")).toBe(false);
    expect(isSafeLabelValue("s/1")).toBe(false);
    expect(isSafeLabelValue("x".repeat(129))).toBe(false);
  });

  it("keeps one owner id per process", () => {
    expect(agentInstanceId()).toBe(agentInstanceId());
    expect(agentInstanceId()).toMatch(/^[A-Za-z0-9_.-]+$/);
  });

  it("builds label args with sandbox, owner, and session", () => {
    const args = sandboxRunLabelArgs("sess-1", "owner-1");
    expect(args).toEqual([
      "--label",
      "traceroot.sandbox=true",
      "--label",
      "traceroot.owner=owner-1",
      "--label",
      "traceroot.session=sess-1",
    ]);
  });

  it("omits an unsafe session label but keeps ownership", () => {
    const args = sandboxRunLabelArgs('s1"; evil', "owner-1");
    expect(args.join(" ")).not.toContain("traceroot.session=");
    expect(args).toContain("traceroot.sandbox=true");
  });

  it("generates prefixed, unique container names", () => {
    const first = sandboxContainerName();
    const second = sandboxContainerName();
    expect(first.startsWith(SANDBOX_NAME_PREFIX)).toBe(true);
    expect(first).not.toBe(second);
  });
});

describe("listLabeledSandboxIds", () => {
  it("splits docker output into ids", async () => {
    routeExecFile(() => `${STALE}\n${ACTIVE}\n`);
    await expect(listLabeledSandboxIds()).resolves.toEqual([STALE, ACTIVE]);
  });

  it("returns empty when no sandboxes exist", async () => {
    routeExecFile(() => "\n");
    await expect(listLabeledSandboxIds()).resolves.toEqual([]);
  });
});

describe("inspectSandboxLabels", () => {
  it("reads sandbox labels in one inspect call", async () => {
    routeExecFile((argv) => {
      expect(argv[0]).toBe("inspect");
      return inspectResponse([
        {
          id: STALE,
          labels: {
            "traceroot.sandbox": "true",
            "traceroot.session": "s-old",
            "traceroot.owner": "dead-owner",
          },
        },
      ]);
    });
    await expect(inspectSandboxLabels([STALE])).resolves.toEqual([
      { id: STALE, sandbox: "true", session: "s-old", owner: "dead-owner" },
    ]);
  });

  it("returns empty for no ids without calling docker", async () => {
    routeExecFile(() => {
      throw new Error("docker must not be called");
    });
    await expect(inspectSandboxLabels([])).resolves.toEqual([]);
  });
});

describe("removeSandboxContainer", () => {
  it("removes by id", async () => {
    routeExecFile((argv) => {
      expect(argv).toEqual(["rm", "-f", STALE]);
      return "";
    });
    await expect(removeSandboxContainer(STALE)).resolves.toBeUndefined();
  });

  it("treats an already-removed container as success", async () => {
    execFileMock.mockImplementation((...callArgs: unknown[]) => {
      const cb = callArgs[callArgs.length - 1] as NodeCallback;
      cb(new Error("Error: No such container: deadbeef"));
    });
    await expect(removeSandboxContainer("deadbeef")).resolves.toBeUndefined();
  });

  it("throws when the daemon fails", async () => {
    execFileMock.mockImplementation((...callArgs: unknown[]) => {
      const cb = callArgs[callArgs.length - 1] as NodeCallback;
      cb(new Error("Cannot connect to the Docker daemon"));
    });
    await expect(removeSandboxContainer(STALE)).rejects.toThrow(/daemon/);
  });
});

describe("reconcileStaleSandboxes", () => {
  it("removes stale sandboxes but keeps the active session's container", async () => {
    const removed: string[] = [];
    execFileMock.mockImplementation((...callArgs: unknown[]) => {
      const cb = callArgs[callArgs.length - 1] as NodeCallback;
      const argv = callArgs[1] as string[];
      try {
        if (argv[0] === "ps" && argv.includes("label=traceroot.sandbox=true")) {
          cb(null, { stdout: `${STALE}\n${ACTIVE}\n`, stderr: "" });
        } else if (argv[0] === "ps") {
          cb(null, { stdout: "", stderr: "" });
        } else if (argv[0] === "inspect") {
          cb(null, {
            stdout: inspectResponse([
              {
                id: STALE,
                labels: {
                  "traceroot.sandbox": "true",
                  "traceroot.session": "s-old",
                  "traceroot.owner": "dead-owner",
                },
              },
              {
                id: ACTIVE,
                labels: {
                  "traceroot.sandbox": "true",
                  "traceroot.session": "s-live",
                  // Another live agent's owner must not matter: the session
                  // is active in this process, so it is kept.
                  "traceroot.owner": "other-live-owner",
                },
              },
            ]),
            stderr: "",
          });
        } else if (argv[0] === "rm") {
          removed.push(argv[argv.length - 1] as string);
          cb(null, { stdout: "", stderr: "" });
        } else {
          cb(new Error(`unexpected argv: ${argv.join(" ")}`));
        }
      } catch (error) {
        cb(error instanceof Error ? error : new Error(String(error)));
      }
    });

    const result = await reconcileStaleSandboxes(new Set(["s-live"]));

    expect(removed).toEqual([STALE]);
    expect(result.removed).toEqual([STALE]);
    expect(result.failed).toEqual([]);
    expect(result.skippedActive).toEqual([ACTIVE]);
  });

  it("reclaims pre-label legacy containers by name", async () => {
    const removed: string[] = [];
    execFileMock.mockImplementation((...callArgs: unknown[]) => {
      const cb = callArgs[callArgs.length - 1] as NodeCallback;
      const argv = callArgs[1] as string[];
      if (argv[0] === "ps" && argv.includes("label=traceroot.sandbox=true")) {
        cb(null, { stdout: "", stderr: "" });
      } else if (argv[0] === "ps") {
        cb(null, { stdout: `${LEGACY}\n`, stderr: "" });
      } else if (argv[0] === "inspect") {
        cb(null, {
          stdout: inspectResponse([{ id: LEGACY, labels: {}, name: "/traceroot-sandbox-123" }]),
          stderr: "",
        });
      } else if (argv[0] === "rm") {
        removed.push(argv[argv.length - 1] as string);
        cb(null, { stdout: "", stderr: "" });
      } else {
        cb(new Error(`unexpected argv: ${argv.join(" ")}`));
      }
    });

    const result = await reconcileStaleSandboxes(new Set());

    expect(removed).toEqual([LEGACY]);
    expect(result.removed).toEqual([LEGACY]);
  });

  it("never removes a container whose name merely contains the prefix", async () => {
    // Docker's `name=` filter is a substring match: `foo-traceroot-sandbox-bar`
    // and `backup-traceroot-sandbox-9` both appear in the legacy listing, but
    // neither name starts with the prefix, so neither may be deleted.
    const unrelatedA = "d".repeat(64);
    const unrelatedB = "e".repeat(64);
    const removed: string[] = [];
    execFileMock.mockImplementation((...callArgs: unknown[]) => {
      const cb = callArgs[callArgs.length - 1] as NodeCallback;
      const argv = callArgs[1] as string[];
      if (argv[0] === "ps" && argv.includes("label=traceroot.sandbox=true")) {
        cb(null, { stdout: "", stderr: "" });
      } else if (argv[0] === "ps") {
        cb(null, { stdout: `${unrelatedA}\n${unrelatedB}\n`, stderr: "" });
      } else if (argv[0] === "inspect") {
        cb(null, {
          stdout: inspectResponse([
            { id: unrelatedA, labels: {}, name: "/foo-traceroot-sandbox-bar" },
            { id: unrelatedB, labels: {}, name: "/backup-traceroot-sandbox-9" },
          ]),
          stderr: "",
        });
      } else if (argv[0] === "rm") {
        removed.push(argv[argv.length - 1] as string);
        cb(null, { stdout: "", stderr: "" });
      } else {
        cb(new Error(`unexpected argv: ${argv.join(" ")}`));
      }
    });

    const result = await reconcileStaleSandboxes(new Set());

    expect(removed).toEqual([]);
    expect(result).toEqual({ removed: [], failed: [], skippedActive: [] });
  });

  it("fails the legacy pass closed when inspection is unavailable", async () => {
    execFileMock.mockImplementation((...callArgs: unknown[]) => {
      const cb = callArgs[callArgs.length - 1] as NodeCallback;
      const argv = callArgs[1] as string[];
      if (argv[0] === "ps" && argv.includes("label=traceroot.sandbox=true")) {
        cb(null, { stdout: "", stderr: "" });
      } else if (argv[0] === "ps") {
        cb(null, { stdout: `${LEGACY}\n`, stderr: "" });
      } else if (argv[0] === "inspect") {
        // The candidate cannot be identified — it must be kept, not deleted.
        cb(new Error("Cannot connect to the Docker daemon"));
      } else if (argv[0] === "rm") {
        cb(new Error(`rm must not run without an inspected name: ${argv.join(" ")}`));
      } else {
        cb(new Error(`unexpected argv: ${argv.join(" ")}`));
      }
    });

    const result = await reconcileStaleSandboxes(new Set());

    expect(result).toEqual({ removed: [], failed: [], skippedActive: [] });
  });

  it("attempts every removal even when one fails", async () => {
    const attempted: string[] = [];
    execFileMock.mockImplementation((...callArgs: unknown[]) => {
      const cb = callArgs[callArgs.length - 1] as NodeCallback;
      const argv = callArgs[1] as string[];
      if (argv[0] === "ps" && argv.includes("label=traceroot.sandbox=true")) {
        cb(null, { stdout: `${STALE}\n${ACTIVE}\n`, stderr: "" });
      } else if (argv[0] === "ps") {
        cb(null, { stdout: "", stderr: "" });
      } else if (argv[0] === "inspect") {
        cb(null, {
          stdout: inspectResponse([
            { id: STALE, labels: { "traceroot.sandbox": "true" } },
            { id: ACTIVE, labels: { "traceroot.sandbox": "true" } },
          ]),
          stderr: "",
        });
      } else if (argv[0] === "rm") {
        const id = argv[argv.length - 1] as string;
        attempted.push(id);
        if (id === STALE) cb(new Error("boom"));
        else cb(null, { stdout: "", stderr: "" });
      } else {
        cb(new Error(`unexpected argv: ${argv.join(" ")}`));
      }
    });

    const result = await reconcileStaleSandboxes(new Set());

    expect(attempted).toEqual([STALE, ACTIVE]);
    expect(result.removed).toEqual([ACTIVE]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.id).toBe(STALE);
  });

  it("never throws when Docker is unavailable", async () => {
    execFileMock.mockImplementation((...callArgs: unknown[]) => {
      const cb = callArgs[callArgs.length - 1] as NodeCallback;
      cb(new Error("Cannot connect to the Docker daemon"));
    });

    const result = await reconcileStaleSandboxes(new Set());
    expect(result).toEqual({ removed: [], failed: [], skippedActive: [] });
  });
});

describe("hasLegacySandboxName", () => {
  it("accepts a genuine legacy name", () => {
    expect(hasLegacySandboxName("traceroot-sandbox-123")).toBe(true);
  });

  it("accepts the leading-slash form Docker inspect returns", () => {
    expect(hasLegacySandboxName("/traceroot-sandbox-123")).toBe(true);
  });

  it("rejects names that merely contain the prefix", () => {
    expect(hasLegacySandboxName("foo-traceroot-sandbox-bar")).toBe(false);
    expect(hasLegacySandboxName("backup-traceroot-sandbox-9")).toBe(false);
    expect(hasLegacySandboxName("/foo-traceroot-sandbox-bar")).toBe(false);
  });

  it("fails closed on a missing or empty name", () => {
    expect(hasLegacySandboxName(undefined)).toBe(false);
    expect(hasLegacySandboxName("")).toBe(false);
  });
});

describe("StartupGate", () => {
  it("lets requests through while open", async () => {
    const gate = new StartupGate();
    expect(gate.isOpen()).toBe(true);
    await expect(gate.wait()).resolves.toBeUndefined();
  });

  it("parks waiters while closed and releases them all", async () => {
    const gate = new StartupGate();
    gate.close();
    expect(gate.isOpen()).toBe(false);
    const order: string[] = [];
    const first = gate.wait().then(() => void order.push("first"));
    const second = gate.wait().then(() => void order.push("second"));
    await new Promise((resolve) => setImmediate(resolve));
    expect(order).toEqual([]);
    gate.release();
    await Promise.all([first, second]);
    expect(order.sort()).toEqual(["first", "second"]);
    expect(gate.isOpen()).toBe(true);
  });

  it("tolerates a redundant release", () => {
    const gate = new StartupGate();
    expect(() => gate.release()).not.toThrow();
    expect(gate.isOpen()).toBe(true);
  });
});

describe("destroyAllExecutors", () => {
  it("destroys every executor even when one fails, and empties the map", async () => {
    const destroyed: string[] = [];
    const executors = new Map<string, { destroy(): Promise<void> }>([
      ["s-1", { destroy: async () => void destroyed.push("s-1") }],
      [
        "s-2",
        {
          destroy: async () => {
            destroyed.push("s-2");
            throw new Error("rm failed");
          },
        },
      ],
      ["s-3", { destroy: async () => void destroyed.push("s-3") }],
    ]);

    const result = await destroyAllExecutors(executors);

    expect(destroyed.sort()).toEqual(["s-1", "s-2", "s-3"]);
    expect(executors.size).toBe(0);
    expect(result.destroyed).toBe(2);
    expect(result.failed.map((f) => f.sessionId)).toEqual(["s-2"]);
  });

  it("handles an empty map", async () => {
    const result = await destroyAllExecutors(new Map());
    expect(result).toEqual({ destroyed: 0, failed: [] });
  });
});
