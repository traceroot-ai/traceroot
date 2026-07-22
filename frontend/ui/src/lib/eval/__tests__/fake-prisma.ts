/**
 * A tiny in-memory stand-in for the subset of the Prisma client the offline-eval
 * reporting + read routes use. Enough to drive the real Route Handlers end to end
 * in a Vitest integration test (the local "SDK contract exerciser") without a
 * database, matching the repo convention of never touching a real DB in tests.
 *
 * Supports top-level-equality `where`, single-key `orderBy`, `create`,
 * `createMany`, `update`, `deleteMany`, `count`, `findFirst/findUnique/findMany`,
 * and an interactive `$transaction` (same store, no rollback). `select` is ignored
 * (the row is returned whole). `include` resolves declared one-to-many relations
 * (see `wireRelations`) so the public dataset-version READ route — which reads
 * `version.testCases` — can be driven end to end; unknown include keys are ignored.
 */

type Row = Record<string, unknown>;

/** A declared one-to-many relation: `model` rows whose `fk` equals this row's `id`. */
type Relation = { model: Model; fk: string };

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
  /** Declared relations resolvable via `include`, keyed by the include field name. */
  relations: Record<string, Relation> = {};
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

  /**
   * Attach each requested `include` relation to a shallow copy of `row` (leaving the
   * stored row untouched). A relation resolves to the target model's rows whose
   * foreign key equals this row's id, honoring an optional nested `orderBy`.
   */
  private withInclude(row: Row | null, include?: Row): Row | null {
    if (!row || !include) return row;
    const out = { ...row };
    for (const [key, spec] of Object.entries(include)) {
      if (!spec) continue;
      const rel = this.relations[key];
      if (!rel) continue;
      const nested = typeof spec === "object" ? (spec as { orderBy?: Row }) : {};
      out[key] = rel.model.order(
        rel.model.rows.filter((r) => r[rel.fk] === row.id),
        nested.orderBy,
      );
    }
    return out;
  }

  async findFirst(args: { where?: Row; orderBy?: Row; include?: Row } = {}) {
    const row =
      this.order(
        this.rows.filter((r) => matches(r, args.where)),
        args.orderBy,
      )[0] ?? null;
    return this.withInclude(row, args.include);
  }
  async findUnique(args: { where?: Row; include?: Row } = {}) {
    const row = this.rows.find((r) => matches(r, args.where)) ?? null;
    return this.withInclude(row, args.include);
  }
  async findMany(args: { where?: Row; orderBy?: Row; include?: Row } = {}) {
    return this.order(
      this.rows.filter((r) => matches(r, args.where)),
      args.orderBy,
    ).map((r) => this.withInclude(r, args.include));
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

  constructor() {
    this.wireRelations();
  }

  // Interactive transaction: same store, no isolation/rollback (fine for tests).
  async $transaction<T>(fn: (tx: this) => Promise<T>): Promise<T> {
    return fn(this);
  }

  /** Declare the relations the routes resolve via `include`. */
  private wireRelations() {
    this.datasetVersion.relations = {
      testCases: { model: this.testCase, fk: "datasetVersionId" },
    };
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
    this.wireRelations();
  }
}

/** Shared instance so the `@traceroot/core` mock and the test see one store. */
export const fakePrisma = new FakePrisma();
