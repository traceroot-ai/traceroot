/**
 * A tiny in-memory stand-in for the subset of the Prisma client the offline-eval
 * reporting + read routes use. Enough to drive the real Route Handlers end to end
 * in a Vitest integration test (the local "SDK contract exerciser") without a
 * database, matching the repo convention of never touching a real DB in tests.
 *
 * Supports top-level-equality `where`, single-key `orderBy`, `create`,
 * `createMany`, `update`, `deleteMany`, `count`, `findFirst/findUnique/findMany`,
 * and an interactive `$transaction` (same store, no rollback). `select`/`include`
 * are ignored (the row is returned whole) — the reporting routes only read scalar
 * fields off what they create, so that is sufficient.
 */

type Row = Record<string, unknown>;

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, v]) => {
    if (v && typeof v === "object" && "in" in (v as Row)) {
      return (v as { in: unknown[] }).in.includes(row[k]);
    }
    return row[k] === v;
  });
}

class Model {
  rows: Row[] = [];
  private seq = 0;
  constructor(private name: string) {}

  private id() {
    this.seq += 1;
    return `${this.name}_${this.seq}`;
  }

  private order(rows: Row[], orderBy?: Row): Row[] {
    if (!orderBy) return rows;
    const [key, dir] = Object.entries(orderBy)[0] as [string, "asc" | "desc"];
    return [...rows].sort((a, b) => {
      const av = a[key] as number | string;
      const bv = b[key] as number | string;
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return dir === "desc" ? -cmp : cmp;
    });
  }

  async findFirst(args: { where?: Row; orderBy?: Row } = {}) {
    return (
      this.order(
        this.rows.filter((r) => matches(r, args.where)),
        args.orderBy,
      )[0] ?? null
    );
  }
  async findUnique(args: { where?: Row } = {}) {
    return this.rows.find((r) => matches(r, args.where)) ?? null;
  }
  async findMany(args: { where?: Row; orderBy?: Row } = {}) {
    return this.order(
      this.rows.filter((r) => matches(r, args.where)),
      args.orderBy,
    );
  }
  async count(args: { where?: Row } = {}) {
    return this.rows.filter((r) => matches(r, args.where)).length;
  }
  async create(args: { data: Row }) {
    const row: Row = { id: args.data.id ?? this.id(), createTime: new Date(), ...args.data };
    this.rows.push(row);
    return row;
  }
  async createMany(args: { data: Row[] }) {
    for (const d of args.data) await this.create({ data: d });
    return { count: args.data.length };
  }
  async update(args: { where: Row; data: Row }) {
    const row = this.rows.find((r) => matches(r, args.where));
    if (!row) throw new Error(`${this.name}.update: not found`);
    Object.assign(row, args.data);
    return row;
  }
  async deleteMany(args: { where?: Row } = {}) {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => !matches(r, args.where));
    return { count: before - this.rows.length };
  }
}

export class FakePrisma {
  accessKey = new Model("accessKey");
  dataset = new Model("dataset");
  datasetVersion = new Model("datasetVersion");
  testCase = new Model("testCase");
  evaluation = new Model("evaluation");
  evaluationRun = new Model("evaluationRun");
  evaluationResult = new Model("evaluationResult");
  score = new Model("score");
  humanScore = new Model("humanScore");

  // Interactive transaction: same store, no isolation/rollback (fine for tests).
  async $transaction<T>(fn: (tx: this) => Promise<T>): Promise<T> {
    return fn(this);
  }

  reset() {
    this.accessKey = new Model("accessKey");
    this.dataset = new Model("dataset");
    this.datasetVersion = new Model("datasetVersion");
    this.testCase = new Model("testCase");
    this.evaluation = new Model("evaluation");
    this.evaluationRun = new Model("evaluationRun");
    this.evaluationResult = new Model("evaluationResult");
    this.score = new Model("score");
    this.humanScore = new Model("humanScore");
  }
}

/** Shared instance so the `@traceroot/core` mock and the test see one store. */
export const fakePrisma = new FakePrisma();
