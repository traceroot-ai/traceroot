import { createHash } from "node:crypto";

/** A small seeded generator: the same seed string always yields the same stream. */
export class Rng {
  private state: number;

  constructor(seed: string) {
    this.state = createHash("sha256").update(seed).digest().readUInt32LE(0) || 1;
  }

  /** A float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** An integer in [low, high] inclusive. */
  int(low: number, high: number): number {
    return low + Math.floor(this.next() * (high - low + 1));
  }

  /** A fresh array in a seeded random order. */
  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = Math.floor(this.next() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }
}

/** A stable lowercase hex id derived from a key, so ids never depend on run order. */
export function hexId(key: string, length: number): string {
  return createHash("sha256").update(key).digest("hex").slice(0, length);
}

/**
 * The standard normal quantile (inverse CDF), by Acklam's rational
 * approximation. Used to lay latencies on a log-normal curve so a window's
 * percentiles land where the scenario says they should.
 */
export function normalQuantile(p: number): number {
  if (p <= 0 || p >= 1) throw new RangeError("p must be strictly between 0 and 1");
  const a = [
    -39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716,
    2.506628277459239,
  ];
  const b = [
    -54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972,
    -13.28068155288572,
  ];
  const c = [
    -0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783,
  ];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const low = 0.02425;
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  if (p > 1 - low) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return (
      -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  const q = p - 0.5;
  const r = q * q;
  return (
    ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  );
}

/**
 * The element ClickHouse's exact quantile would return: the sorted value at
 * index floor(level * n), clamped to the last. The manifest uses it so its
 * percentiles equal what the aggregate query reports.
 */
export function exactQuantile(values: readonly number[], level: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((x, y) => x - y);
  const index = Math.min(sorted.length - 1, Math.floor(level * sorted.length));
  return sorted[index];
}

/** ClickHouse's DateTime64(3) text form, always UTC. */
export function chDateTime(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace("Z", "");
}
