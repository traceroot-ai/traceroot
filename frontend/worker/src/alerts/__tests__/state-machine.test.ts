import { describe, it, expect } from "vitest";
import type {
  AlertNoDataMode,
  AlertRenotify,
  AlertSeverity,
  AlertThresholdOperator,
} from "@traceroot/core";
import {
  applyAlertStateMachine,
  compareToThreshold,
  deriveAlertSeverity,
  type AlertRuntimeState,
} from "../state-machine.js";

const T0 = new Date("2026-08-12T10:00:00.000Z");
const NOW = new Date("2026-08-12T10:30:00.000Z");

const OFF: AlertRenotify = { mode: "OFF" };
const every = (intervalMinutes: number): AlertRenotify => ({ mode: "EVERY", intervalMinutes });

const COLD_START: AlertRuntimeState = {
  severity: "UNKNOWN",
  severityChangedAt: null,
  alertedAt: null,
};

function state(
  severity: AlertSeverity,
  severityChangedAt: Date | null,
  alertedAt: Date | null,
): AlertRuntimeState {
  return { severity, severityChangedAt, alertedAt };
}

const minutesBefore = (from: Date, minutes: number): Date =>
  new Date(from.getTime() - minutes * 60_000);

describe("applyAlertStateMachine — what a rule announces", () => {
  it("emits only for a never-evaluated rule that comes up ALERT", () => {
    expect(applyAlertStateMachine(COLD_START, "ALERT", NOW, OFF)).toEqual({
      emit: true,
      nextState: { severity: "ALERT", severityChangedAt: NOW, alertedAt: NOW },
    });
    expect(applyAlertStateMachine(COLD_START, "OK", NOW, OFF)).toEqual({
      emit: false,
      nextState: { severity: "OK", severityChangedAt: NOW, alertedAt: null },
    });
    expect(applyAlertStateMachine(COLD_START, "NO_DATA", NOW, OFF)).toEqual({
      emit: false,
      nextState: { severity: "NO_DATA", severityChangedAt: NOW, alertedAt: null },
    });
  });

  it("stays quiet, and holds both clocks still, on a self-loop renotify does not cover", () => {
    const notifiedAt = minutesBefore(NOW, 600);

    for (const previous of [
      state("OK", T0, notifiedAt),
      state("NO_DATA", T0, notifiedAt),
      state("ALERT", T0, minutesBefore(NOW, 10_000)),
    ]) {
      // Renotify is for breaches, and OFF covers a breach however long it holds.
      const renotify = previous.severity === "ALERT" ? OFF : every(1);
      const { emit, nextState } = applyAlertStateMachine(
        previous,
        previous.severity,
        NOW,
        renotify,
      );

      expect(emit).toBe(false);
      expect(nextState).toEqual(previous);
    }
  });

  it("emits on the entry into ALERT and the recovery out of it, whatever renotify says", () => {
    for (const renotify of [OFF, every(1), every(10_080)]) {
      expect(applyAlertStateMachine(state("OK", T0, null), "ALERT", NOW, renotify)).toEqual({
        emit: true,
        nextState: { severity: "ALERT", severityChangedAt: NOW, alertedAt: NOW },
      });
      expect(applyAlertStateMachine(state("ALERT", T0, T0), "OK", NOW, renotify)).toEqual({
        emit: true,
        nextState: { severity: "OK", severityChangedAt: NOW, alertedAt: NOW },
      });
    }
  });

  it("enters NO_DATA silently from anywhere, and leaves it loudly only on a breach", () => {
    for (const previousSeverity of ["UNKNOWN", "OK", "ALERT", "NO_DATA"] as const) {
      const previous = state(previousSeverity, T0, T0);
      expect(applyAlertStateMachine(previous, "NO_DATA", NOW, every(1)).emit).toBe(false);
    }

    const noData = state("NO_DATA", T0, null);
    const breach = applyAlertStateMachine(noData, "ALERT", NOW, OFF);
    expect(breach.emit).toBe(true);
    expect(breach.nextState.alertedAt).toEqual(NOW);
    expect(applyAlertStateMachine(noData, "OK", NOW, OFF)).toEqual({
      emit: false,
      nextState: { severity: "OK", severityChangedAt: NOW, alertedAt: null },
    });
  });

  it("announces the recovery of a breach the source dropped out of, whatever renotify says", () => {
    const pagedAt = minutesBefore(NOW, 45);

    for (const renotify of [OFF, every(1), every(10_080)]) {
      // ALERT → NO_DATA holds the page open, so the OK on the far side is the
      // all-clear for a breach somebody was paged for.
      const gap = applyAlertStateMachine(state("ALERT", T0, pagedAt), "NO_DATA", NOW, renotify);
      expect(gap.emit).toBe(false);
      expect(gap.nextState.alertedAt).toEqual(pagedAt);

      expect(applyAlertStateMachine(gap.nextState, "OK", NOW, renotify)).toEqual({
        emit: true,
        nextState: { severity: "OK", severityChangedAt: NOW, alertedAt: NOW },
      });
    }
  });

  it("does not invent a recovery for a quiet rule that merely lost its data", () => {
    // OK → NO_DATA → OK: nobody was paged, so nobody is told it is over.
    const recoveredAt = minutesBefore(NOW, 120);
    const gap = applyAlertStateMachine(state("OK", T0, recoveredAt), "NO_DATA", NOW, every(1));

    expect(gap.nextState.alertedAt).toBeNull();
    expect(applyAlertStateMachine(gap.nextState, "OK", NOW, every(1)).emit).toBe(false);
  });

  it("re-enters ALERT out of NO_DATA on renotify's terms rather than on every crossing", () => {
    // A source flapping in and out of reach is one breach, not one per return.
    const outstanding = state("NO_DATA", T0, minutesBefore(NOW, 20));

    expect(applyAlertStateMachine(outstanding, "ALERT", NOW, OFF).emit).toBe(false);
    expect(applyAlertStateMachine(outstanding, "ALERT", NOW, every(30)).emit).toBe(false);
    expect(applyAlertStateMachine(outstanding, "ALERT", NOW, every(20))).toEqual({
      emit: true,
      nextState: { severity: "ALERT", severityChangedAt: NOW, alertedAt: NOW },
    });
  });
});

describe("applyAlertStateMachine — renotify and the clocks it must not disturb", () => {
  it("re-emits at the interval boundary and not one minute short of it", () => {
    const emitsAfter = (minutes: number): boolean =>
      applyAlertStateMachine(
        state("ALERT", T0, minutesBefore(NOW, minutes)),
        "ALERT",
        NOW,
        every(30),
      ).emit;

    expect(emitsAfter(31)).toBe(true);
    expect(emitsAfter(30)).toBe(true);
    expect(emitsAfter(29)).toBe(false);
  });

  it("measures the interval from the last notification, not from the severity change", () => {
    // Breaching for five hours, notified one minute ago: too soon to speak again.
    const previous = state("ALERT", minutesBefore(NOW, 300), minutesBefore(NOW, 1));
    expect(applyAlertStateMachine(previous, "ALERT", NOW, every(30)).emit).toBe(false);
  });

  it("stays quiet on a self-loop when the alert has never fired", () => {
    const previous = state("ALERT", T0, null);
    const aYearOn = new Date(NOW.getTime() + 365 * 24 * 60 * 60_000);

    for (const [at, renotify] of [
      [NOW, every(1)],
      [aYearOn, every(1)],
      [NOW, every(0)],
    ] as const) {
      expect(applyAlertStateMachine(previous, "ALERT", at, renotify)).toEqual({
        emit: false,
        nextState: previous,
      });
    }
  });

  it("advances alertedAt on a renotify while leaving severityChangedAt where it was", () => {
    const breachedAt = minutesBefore(NOW, 300);
    const previous = state("ALERT", breachedAt, minutesBefore(NOW, 30));

    const { emit, nextState } = applyAlertStateMachine(previous, "ALERT", NOW, every(30));

    expect(emit).toBe(true);
    expect(nextState.alertedAt).toEqual(NOW);
    expect(nextState.severityChangedAt).toEqual(breachedAt);
  });

  it("advances severityChangedAt on a silent severity change while leaving alertedAt where it was", () => {
    const lastNotifiedAt = minutesBefore(NOW, 90);
    const previous = state("ALERT", T0, lastNotifiedAt);

    const { emit, nextState } = applyAlertStateMachine(previous, "NO_DATA", NOW, every(1));

    expect(emit).toBe(false);
    expect(nextState.severityChangedAt).toEqual(NOW);
    expect(nextState.alertedAt).toEqual(lastNotifiedAt);
  });

  it("keeps the renotify interval anchored across repeated silent evaluations", () => {
    const notifiedAt = new Date("2026-08-12T10:00:00.000Z");
    let current = state("ALERT", notifiedAt, notifiedAt);

    // Ten silent minutes must not reset the 30-minute renotify clock.
    for (let minute = 1; minute <= 10; minute += 1) {
      const tick = new Date(notifiedAt.getTime() + minute * 60_000);
      const result = applyAlertStateMachine(current, "ALERT", tick, every(30));
      expect(result.emit).toBe(false);
      current = result.nextState;
    }

    const atInterval = new Date(notifiedAt.getTime() + 30 * 60_000);
    expect(applyAlertStateMachine(current, "ALERT", atInterval, every(30)).emit).toBe(true);
  });

  it("leaves the previous state object untouched", () => {
    const previous = state("ALERT", T0, minutesBefore(NOW, 60));
    const snapshot = { ...previous };

    applyAlertStateMachine(previous, "OK", NOW, every(30));

    expect(previous).toEqual(snapshot);
  });
});

describe("the reading a rule takes of a gap", () => {
  const SEVERITIES: AlertSeverity[] = ["UNKNOWN", "OK", "ALERT", "NO_DATA"];
  const RENOTIFIES: AlertRenotify[] = [OFF, every(1), every(30)];

  it("reads a gap the same when the rule names no mode as under HOLD", () => {
    // The stack's whole history was written against the unnamed call, so HOLD
    // has to be that call and nothing else.
    for (const previousSeverity of SEVERITIES) {
      for (const severity of SEVERITIES) {
        for (const renotify of RENOTIFIES) {
          const previous = state(previousSeverity, T0, minutesBefore(NOW, 45));
          expect(applyAlertStateMachine(previous, severity, NOW, renotify, "HOLD")).toEqual(
            applyAlertStateMachine(previous, severity, NOW, renotify),
          );
        }
      }
    }
  });

  it("puts an empty window to the threshold as a zero under ZERO", () => {
    // A count over a window that received nothing is honestly zero, so a rule
    // watching for the floor has to be able to fire on the silence.
    expect(deriveAlertSeverity(null, "<", 500, "ZERO")).toBe("ALERT");
    expect(deriveAlertSeverity(null, ">", 500, "ZERO")).toBe("OK");
    expect(deriveAlertSeverity(null, "=", 0, "ZERO")).toBe("ALERT");
    for (const value of [null, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(deriveAlertSeverity(value, "<=", 0, "ZERO")).toBe("ALERT");
      expect(deriveAlertSeverity(value, "<=", 0, "HOLD")).toBe("NO_DATA");
      expect(deriveAlertSeverity(value, "<=", 0, "NOTIFY")).toBe("NO_DATA");
    }
    // A window that did measure is judged on what it measured, in every mode.
    for (const mode of ["HOLD", "ZERO", "NOTIFY"] as AlertNoDataMode[]) {
      expect(deriveAlertSeverity(600, ">", 500, mode)).toBe("ALERT");
      expect(deriveAlertSeverity(400, ">", 500, mode)).toBe("OK");
    }
  });

  it("pages on the silence and again on its end under NOTIFY", () => {
    const gap = applyAlertStateMachine(state("OK", T0, null), "NO_DATA", NOW, OFF, "NOTIFY");
    expect(gap).toEqual({
      emit: true,
      nextState: { severity: "NO_DATA", severityChangedAt: NOW, alertedAt: NOW },
    });

    const later = new Date(NOW.getTime() + 60 * 60_000);
    expect(applyAlertStateMachine(gap.nextState, "OK", later, OFF, "NOTIFY")).toEqual({
      emit: true,
      nextState: { severity: "OK", severityChangedAt: later, alertedAt: later },
    });
  });

  it("repeats a standing gap on renotify's terms and not on every tick, under NOTIFY", () => {
    const paged = state("NO_DATA", T0, minutesBefore(NOW, 20));

    expect(applyAlertStateMachine(paged, "NO_DATA", NOW, OFF, "NOTIFY").emit).toBe(false);
    expect(applyAlertStateMachine(paged, "NO_DATA", NOW, every(30), "NOTIFY").emit).toBe(false);
    expect(applyAlertStateMachine(paged, "NO_DATA", NOW, every(20), "NOTIFY")).toEqual({
      emit: true,
      nextState: { severity: "NO_DATA", severityChangedAt: T0, alertedAt: NOW },
    });
  });

  it("breaks out of a gap loudly, in every mode and whatever renotify says", () => {
    // A gap nobody was paged for that comes back breaching is a fresh breach,
    // and a fresh breach is never held back.
    const unpaged = state("NO_DATA", T0, null);

    for (const mode of ["HOLD", "ZERO", "NOTIFY"] as AlertNoDataMode[]) {
      for (const renotify of RENOTIFIES) {
        expect(applyAlertStateMachine(unpaged, "ALERT", NOW, renotify, mode)).toEqual({
          emit: true,
          nextState: { severity: "ALERT", severityChangedAt: NOW, alertedAt: NOW },
        });
      }
    }

    // Under NOTIFY the gap itself was the page, so the breach on the far side
    // is news too, however recently the gap spoke.
    const paged = state("NO_DATA", T0, minutesBefore(NOW, 1));
    expect(applyAlertStateMachine(paged, "ALERT", NOW, OFF, "NOTIFY").emit).toBe(true);
    expect(applyAlertStateMachine(paged, "ALERT", NOW, every(600), "NOTIFY").emit).toBe(true);
  });

  it("still says nothing on an unevaluated rule, in every mode", () => {
    for (const mode of ["HOLD", "ZERO", "NOTIFY"] as AlertNoDataMode[]) {
      expect(applyAlertStateMachine(COLD_START, "UNKNOWN", NOW, every(1), mode).emit).toBe(false);
    }
  });
});

const OPERATORS: AlertThresholdOperator[] = [">", ">=", "<", "<=", "=", "!="];

describe("deriveAlertSeverity", () => {
  it("judges a measured zero instead of discarding it as an absence", () => {
    const zero = (operator: AlertThresholdOperator): AlertSeverity =>
      deriveAlertSeverity(0, operator, 500);

    expect(OPERATORS.map(zero)).toEqual(["OK", "OK", "ALERT", "ALERT", "OK", "ALERT"]);
    // The dead man's switch: count over a window that stopped receiving spans is
    // honestly zero, and a rule watching for that zero has to be able to fire.
    expect(deriveAlertSeverity(0, "=", 0)).toBe("ALERT");
  });

  it("reports NO_DATA for a value the window could not measure, whatever the comparison", () => {
    // avg, the percentiles, min and max over an empty window arrive as null:
    // comparing the column default instead would read a dead pipeline as a
    // latency win.
    for (const operator of OPERATORS) {
      expect(deriveAlertSeverity(null, operator, 500)).toBe("NO_DATA");
    }
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(deriveAlertSeverity(value, "<", 500)).toBe("NO_DATA");
    }
  });

  it("applies each of the six operators at, above and below the threshold", () => {
    const at = (value: number, operator: AlertThresholdOperator): AlertSeverity =>
      deriveAlertSeverity(value, operator, 100);

    expect([at(101, ">"), at(100, ">"), at(99, ">")]).toEqual(["ALERT", "OK", "OK"]);
    expect([at(101, ">="), at(100, ">="), at(99, ">=")]).toEqual(["ALERT", "ALERT", "OK"]);
    expect([at(101, "<"), at(100, "<"), at(99, "<")]).toEqual(["OK", "OK", "ALERT"]);
    expect([at(101, "<="), at(100, "<="), at(99, "<=")]).toEqual(["OK", "ALERT", "ALERT"]);
    expect([at(101, "="), at(100, "="), at(99, "=")]).toEqual(["OK", "ALERT", "OK"]);
    expect([at(101, "!="), at(100, "!="), at(99, "!=")]).toEqual(["ALERT", "OK", "ALERT"]);

    expect(deriveAlertSeverity(-5, "<", -1)).toBe("ALERT");
    expect(deriveAlertSeverity(-5, ">", -1)).toBe("OK");
  });
});

describe("compareToThreshold", () => {
  it("compares fractional values exactly", () => {
    expect(compareToThreshold(0.1 + 0.2, "=", 0.3)).toBe(false);
    expect(compareToThreshold(0.5, ">", 0.25)).toBe(true);
  });
});
