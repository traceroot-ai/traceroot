import { Prisma } from "@prisma/client";

/**
 * A tiny in-memory stand-in for the subset of the Prisma client the offline-eval
 * reporting + read routes use. Enough to drive the real Route Handlers end to end
 * in a Vitest integration test (the local "SDK contract exerciser") without a
 * database, matching the repo convention of never touching a real DB in tests.
 *
 * Supports top-level-equality `where` (incl. compound-unique-key objects, e.g.
 * `{ runId_testCaseId: { runId, testCaseId } }`), single-key `orderBy`, `create`,
 * `createMany`, `update`, `updateMany` (a real compare-and-swap: it re-checks
 * `where` per matched row), `upsert`, `delete` (cascading through declared
 * `hasMany` relations, e.g. deleting a `dataset` takes its `datasetVersion`s and
 * their `testCase`s with it — the fake's analogue of the schema's `onDelete:
 * Cascade`), `deleteMany` (not cascading), `count`,
 * `findFirst/findUnique/findMany` (with `take`/`skip`/`cursor`), and an
 * interactive `$transaction` that snapshots every model on entry and restores it
 * if `fn` rejects, so a route that writes some rows and then throws leaves no
 * partial mutation behind. `select` is ignored (the row is returned whole).
 * `include` resolves declared one-to-many relations (see `wireRelations`) so the
 * public dataset-version READ route — which reads `version.testCases` — can be
 * driven end to end; unknown include keys are ignored.
 *
 * Every `@@unique`/`@unique` this surface declares (see each Model's
 * `uniqueKeys` below) is enforced: `create`/`update`/`upsert` throw a real
 * `Prisma.PrismaClientKnownRequestError` (code `P2002`) on collision, matching
 * what the routes already catch. A null/undefined key field never collides —
 * Postgres unique constraints treat NULL as distinct from any other NULL (e.g. a
 * dataset version published without an `idempotency_key`). A compound key's
 * client-accessor name is its fields joined by "_" (Prisma's convention for
 * `@@unique([a, b])`), which doubles as how `where` resolves it back to its
 * constituent fields.
 *
 * `$transaction(fn)` hands `fn` a per-call view (`TxModel`) wrapping each model,
 * closing over an undo log private to that one call. A mutation records exactly
 * what it changed (the inserted id, or the prior value of an updated/deleted
 * row); on rejection those entries are undone in reverse, restoring only what
 * THIS transaction touched. That is deliberately not a whole-store
 * snapshot/restore: two `$transaction` calls driven concurrently with
 * `Promise.all` genuinely interleave (every fake method is async), and a
 * global snapshot taken at one call's start would, when that call rolls back,
 * erase whatever the OTHER call committed in between. Per-row undo can't do
 * that — it only ever reverses rows it can name.
 */

type Row = Record<string, unknown>;

/**
 * A declared relation resolvable via `include`. `hasMany`: `model` rows whose
 * `fk` equals this row's `id` (e.g. a version's `testCases`). `belongsTo`: the
 * single `model` row whose `id` equals this row's own `fk` field (e.g. a
 * version's owning `dataset`).
 */
type Relation = { kind: "hasMany" | "belongsTo"; model: Model; fk: string };

/**
 * One declared `@@unique`/`@unique`. `fields` joined by "_" is both the client's
 * compound-key `where` accessor (e.g. `runId_testCaseId`) and how the constraint
 * is checked on write; `name` is the constraint Postgres reports on a P2002.
 */
type UniqueKey = { fields: string[]; name: string };

/** One reversible mutation, enough to undo it without touching anything else. */
type UndoEntry =
  | { kind: "insert"; model: Model; id: unknown }
  | { kind: "mutate"; model: Model; id: unknown; prev: Row }
  | { kind: "delete"; model: Model; rows: Row[] };

function throwUniqueViolation(name: string): never {
  throw new Prisma.PrismaClientKnownRequestError(
    `Unique constraint failed on the constraint: \`${name}\``,
    { code: "P2002", clientVersion: "5.22.0", meta: { target: name } },
  );
}

class Model {
  rows: Row[] = [];
  /** Declared relations resolvable via `include`, keyed by the include field name. */
  relations: Record<string, Relation> = {};
  private seq = 0;
  constructor(
    private name: string,
    private uniqueKeys: UniqueKey[] = [],
    private hasUpdatedAt = false,
  ) {}

  private id() {
    this.seq += 1;
    return `${this.name}_${this.seq}`;
  }

  private matches(row: Row, where: Row | undefined): boolean {
    if (!where) return true;
    return Object.entries(where).every(([k, v]) => {
      // A compound-unique-key `where`, e.g. { runId_testCaseId: { runId, testCaseId } }:
      // decompose it back into its constituent fields rather than looking for a
      // literal "runId_testCaseId" column.
      const uk = this.uniqueKeys.find((u) => u.fields.join("_") === k);
      if (uk && v && typeof v === "object") {
        return uk.fields.every((f) => row[f] === (v as Row)[f]);
      }
      if (v && typeof v === "object" && "in" in (v as Row)) {
        return (v as { in: unknown[] }).in.includes(row[k]);
      }
      return row[k] === v;
    });
  }

  /** Throw P2002 if `row` collides with an existing row (other than `excludeId`,
   * for an update-in-place) on any declared unique key. */
  private checkUnique(row: Row, excludeId?: unknown) {
    for (const uk of this.uniqueKeys) {
      if (uk.fields.some((f) => row[f] === null || row[f] === undefined)) continue;
      const dup = this.rows.find(
        (r) => r.id !== excludeId && uk.fields.every((f) => r[f] === row[f]),
      );
      if (dup) throwUniqueViolation(uk.name);
    }
  }

  // `orderBy` is either one `{ field: dir }` or, for a tie-break, an array of
  // them applied in order (e.g. `[{ createTime: "desc" }, { testCaseId: "desc" }]`).
  private order(rows: Row[], orderBy?: Row | Row[]): Row[] {
    if (!orderBy) return rows;
    const specs = (Array.isArray(orderBy) ? orderBy : [orderBy]).map(
      (spec) => Object.entries(spec)[0] as [string, "asc" | "desc"],
    );
    return [...rows].sort((a, b) => {
      for (const [key, dir] of specs) {
        const av = a[key] as number | string;
        const bv = b[key] as number | string;
        const cmp = av < bv ? -1 : av > bv ? 1 : 0;
        if (cmp !== 0) return dir === "desc" ? -cmp : cmp;
      }
      return 0;
    });
  }

  /**
   * Attach each requested `include` relation to a shallow copy of `row` (leaving
   * the stored row untouched). `hasMany` resolves to the target model's rows
   * whose foreign key equals this row's id (honoring an optional nested
   * `orderBy`); `belongsTo` resolves to the single target row this row's own
   * foreign key points at (or `null` if it doesn't point anywhere / the target
   * is gone).
   */
  private withInclude(row: Row | null, include?: Row): Row | null {
    if (!row || !include) return row;
    const out = { ...row };
    for (const [key, spec] of Object.entries(include)) {
      if (!spec) continue;
      const rel = this.relations[key];
      if (!rel) continue;
      if (rel.kind === "belongsTo") {
        out[key] = rel.model.rows.find((r) => r.id === row[rel.fk]) ?? null;
        continue;
      }
      const nested = typeof spec === "object" ? (spec as { orderBy?: Row | Row[] }) : {};
      out[key] = rel.model.order(
        rel.model.rows.filter((r) => r[rel.fk] === row.id),
        nested.orderBy,
      );
    }
    return out;
  }

  async findFirst(args: { where?: Row; orderBy?: Row | Row[]; include?: Row } = {}) {
    const row =
      this.order(
        this.rows.filter((r) => this.matches(r, args.where)),
        args.orderBy,
      )[0] ?? null;
    return this.withInclude(row, args.include);
  }
  async findUnique(args: { where?: Row; include?: Row } = {}) {
    const row = this.rows.find((r) => this.matches(r, args.where)) ?? null;
    return this.withInclude(row, args.include);
  }
  async findMany(
    args: {
      where?: Row;
      orderBy?: Row | Row[];
      include?: Row;
      take?: number;
      skip?: number;
      cursor?: Row;
    } = {},
  ) {
    let rows = this.order(
      this.rows.filter((r) => this.matches(r, args.where)),
      args.orderBy,
    );
    // Cursor pagination: find the cursor row in the (already filtered + ordered)
    // page, then start from it — `skip: 1` (the routes always pair the two) moves
    // past it so the next page starts right after.
    if (args.cursor) {
      const idx = rows.findIndex((r) => this.matches(r, args.cursor));
      rows = idx >= 0 ? rows.slice(idx) : [];
    }
    if (args.skip) rows = rows.slice(args.skip);
    if (args.take !== undefined) rows = rows.slice(0, args.take);
    return rows.map((r) => this.withInclude(r, args.include));
  }
  async count(args: { where?: Row } = {}) {
    return this.rows.filter((r) => this.matches(r, args.where)).length;
  }
  // Minimal groupBy: groups the filtered rows by the `by` fields and returns each
  // group's key fields plus `_count._all` (the only aggregate the routes use).
  async groupBy(args: { by: string[]; where?: Row; _count?: { _all?: boolean } }) {
    const groups = new Map<string, { key: Row; n: number }>();
    for (const r of this.rows.filter((row) => this.matches(row, args.where))) {
      const k = JSON.stringify(args.by.map((f) => r[f]));
      const g = groups.get(k);
      if (g) g.n += 1;
      else {
        const key: Row = {};
        for (const f of args.by) key[f] = r[f];
        groups.set(k, { key, n: 1 });
      }
    }
    return [...groups.values()].map((g) => ({
      ...g.key,
      ...(args._count ? { _count: { _all: g.n } } : {}),
    }));
  }
  // Every mutator takes an optional undo `log`: outside a transaction it is
  // omitted and the write is simply permanent; `TxModel` passes its call's own
  // log so a later rollback can find exactly what to undo.
  async create(args: { data: Row }, log?: UndoEntry[]) {
    const row: Row = {
      id: args.data.id ?? this.id(),
      createTime: new Date(),
      ...(this.hasUpdatedAt ? { updateTime: new Date() } : {}),
      ...args.data,
    };
    this.checkUnique(row);
    this.rows.push(row);
    log?.push({ kind: "insert", model: this, id: row.id });
    return row;
  }
  async createMany(args: { data: Row[] }, log?: UndoEntry[]) {
    for (const d of args.data) await this.create({ data: d }, log);
    return { count: args.data.length };
  }
  async update(args: { where: Row; data: Row }, log?: UndoEntry[]) {
    const row = this.rows.find((r) => this.matches(r, args.where));
    if (!row) throw new Error(`${this.name}.update: not found`);
    const next = { ...row, ...args.data, ...(this.hasUpdatedAt ? { updateTime: new Date() } : {}) };
    this.checkUnique(next, row.id);
    const prev = { ...row };
    Object.assign(row, args.data, this.hasUpdatedAt ? { updateTime: new Date() } : {});
    log?.push({ kind: "mutate", model: this, id: row.id, prev });
    return row;
  }
  async upsert(args: { where: Row; create: Row; update: Row }, log?: UndoEntry[]) {
    const row = this.rows.find((r) => this.matches(r, args.where));
    if (row) return this.update({ where: { id: row.id }, data: args.update }, log);
    return this.create({ data: args.create }, log);
  }
  async updateMany(args: { where?: Row; data: Row }, log?: UndoEntry[]) {
    const matched = this.rows.filter((r) => this.matches(r, args.where));
    for (const row of matched) {
      const next = {
        ...row,
        ...args.data,
        ...(this.hasUpdatedAt ? { updateTime: new Date() } : {}),
      };
      this.checkUnique(next, row.id);
      const prev = { ...row };
      Object.assign(row, args.data, this.hasUpdatedAt ? { updateTime: new Date() } : {});
      log?.push({ kind: "mutate", model: this, id: row.id, prev });
    }
    return { count: matched.length };
  }
  async deleteMany(args: { where?: Row } = {}, log?: UndoEntry[]) {
    const removed = this.rows.filter((r) => this.matches(r, args.where));
    if (removed.length === 0) return { count: 0 };
    this.rows = this.rows.filter((r) => !this.matches(r, args.where));
    log?.push({ kind: "delete", model: this, rows: removed });
    return { count: removed.length };
  }
  /**
   * Singular delete: exactly one row (Prisma throws P2025 if none matches),
   * cascading through every declared `hasMany` relation first — deepest child
   * rows go before their parent — the fake's analogue of the schema's
   * `onDelete: Cascade` (e.g. deleting a `dataset` takes its `datasetVersion`s
   * and, transitively, their `testCase`s with it). `belongsTo` relations are
   * never followed: deleting a version must not take its owning dataset with it.
   */
  async delete(args: { where: Row }, log?: UndoEntry[]) {
    const row = this.rows.find((r) => this.matches(r, args.where));
    if (!row) throw new Error(`${this.name}.delete: not found`);
    this.cascadeRemove(row, log);
    return row;
  }
  private cascadeRemove(row: Row, log?: UndoEntry[]) {
    for (const rel of Object.values(this.relations)) {
      if (rel.kind !== "hasMany") continue;
      for (const child of rel.model.rows.filter((r) => r[rel.fk] === row.id)) {
        rel.model.cascadeRemove(child, log);
      }
    }
    this.rows = this.rows.filter((r) => r !== row);
    log?.push({ kind: "delete", model: this, rows: [row] });
  }
}

/**
 * The `tx` a `$transaction` callback receives: same models, same rows, but every
 * mutation is appended to this one call's own `log` instead of a shared/global
 * one — see the file-level doc for why that matters under concurrent calls.
 */
class TxModel {
  constructor(
    private base: Model,
    private log: UndoEntry[],
  ) {}
  findFirst(args?: Parameters<Model["findFirst"]>[0]) {
    return this.base.findFirst(args);
  }
  findUnique(args?: Parameters<Model["findUnique"]>[0]) {
    return this.base.findUnique(args);
  }
  findMany(args?: Parameters<Model["findMany"]>[0]) {
    return this.base.findMany(args);
  }
  count(args?: Parameters<Model["count"]>[0]) {
    return this.base.count(args);
  }
  create(args: Parameters<Model["create"]>[0]) {
    return this.base.create(args, this.log);
  }
  createMany(args: Parameters<Model["createMany"]>[0]) {
    return this.base.createMany(args, this.log);
  }
  update(args: Parameters<Model["update"]>[0]) {
    return this.base.update(args, this.log);
  }
  upsert(args: Parameters<Model["upsert"]>[0]) {
    return this.base.upsert(args, this.log);
  }
  updateMany(args: Parameters<Model["updateMany"]>[0]) {
    return this.base.updateMany(args, this.log);
  }
  deleteMany(args?: Parameters<Model["deleteMany"]>[0]) {
    return this.base.deleteMany(args, this.log);
  }
  delete(args: Parameters<Model["delete"]>[0]) {
    return this.base.delete(args, this.log);
  }
}

export class FakePrisma {
  accessKey = new Model("accessKey");
  dataset = new Model(
    "dataset",
    [{ fields: ["projectId", "clientDatasetId"], name: "uq_dataset_project_client_id" }],
    true,
  );
  datasetVersion = new Model("datasetVersion", [
    { fields: ["datasetId", "versionNumber"], name: "uq_dataset_version_number" },
    { fields: ["datasetId", "idempotencyKey"], name: "uq_dataset_version_idempotency" },
  ]);
  testCase = new Model("testCase");
  evaluation = new Model(
    "evaluation",
    [{ fields: ["projectId", "evaluationKey"], name: "uq_evaluation_project_key" }],
    true,
  );
  evaluationRun = new Model(
    "evaluationRun",
    [
      { fields: ["evaluationId", "clientRunId"], name: "uq_run_client_run_id" },
      { fields: ["evaluationId", "runNumber"], name: "uq_run_evaluation_run_number" },
    ],
    true,
  );
  evaluationResult = new Model(
    "evaluationResult",
    [{ fields: ["runId", "testCaseId"], name: "uq_result_run_test_case" }],
    true,
  );
  score = new Model("score", [
    { fields: ["resultId", "scorerName", "scorerVersion"], name: "uq_score_result_scorer" },
  ]);
  humanScore = new Model("humanScore");

  constructor() {
    this.wireRelations();
  }

  // Interactive transaction: `fn` gets a `tx` whose mutations are logged to this
  // one call's private undo log (see `TxModel`) and undone, in reverse, if `fn`
  // rejects — precise per-row rollback rather than a whole-store snapshot, which
  // a concurrently interleaved `$transaction` call could otherwise stomp on.
  async $transaction<T>(fn: (tx: this) => Promise<T>): Promise<T> {
    const log: UndoEntry[] = [];
    const tx = this.txView(log);
    try {
      return await fn(tx);
    } catch (e) {
      for (let i = log.length - 1; i >= 0; i--) {
        const entry = log[i];
        if (entry.kind === "insert") {
          entry.model.rows = entry.model.rows.filter((r) => r.id !== entry.id);
        } else if (entry.kind === "mutate") {
          const row = entry.model.rows.find((r) => r.id === entry.id);
          if (row) Object.assign(row, entry.prev);
        } else {
          entry.model.rows.push(...entry.rows);
        }
      }
      throw e;
    }
  }

  private modelEntries(): Array<[string, Model]> {
    return Object.entries(this).filter((e): e is [string, Model] => e[1] instanceof Model);
  }

  /** A `this`-shaped view whose models are `TxModel`s sharing one undo log. */
  private txView(log: UndoEntry[]): this {
    const view: Record<string, unknown> = { $transaction: this.$transaction.bind(this) };
    for (const [key, model] of this.modelEntries()) view[key] = new TxModel(model, log);
    return view as this;
  }

  /**
   * Declare the relations the routes resolve via `include`, and — via `hasMany`
   * — the cascade graph `delete` follows. Matches schema.prisma's `onDelete:
   * Cascade` edges: dataset → version → test case, and evaluation → run →
   * result → score/human score. Deliberately NOT wired: run → dataset version
   * is `onDelete: NoAction` in the schema (a pinned version must survive a
   * dataset delete's cascade so a run can still be read), so there is no
   * `hasMany` from datasetVersion to evaluationRun here.
   */
  private wireRelations() {
    this.datasetVersion.relations = {
      testCases: { kind: "hasMany", model: this.testCase, fk: "datasetVersionId" },
      dataset: { kind: "belongsTo", model: this.dataset, fk: "datasetId" },
    };
    this.dataset.relations = {
      versions: { kind: "hasMany", model: this.datasetVersion, fk: "datasetId" },
    };
    this.evaluation.relations = {
      runs: { kind: "hasMany", model: this.evaluationRun, fk: "evaluationId" },
    };
    this.evaluationRun.relations = {
      results: { kind: "hasMany", model: this.evaluationResult, fk: "runId" },
    };
    this.evaluationResult.relations = {
      scores: { kind: "hasMany", model: this.score, fk: "resultId" },
      humanScores: { kind: "hasMany", model: this.humanScore, fk: "resultId" },
    };
  }

  reset() {
    this.accessKey = new Model("accessKey");
    this.dataset = new Model(
      "dataset",
      [{ fields: ["projectId", "clientDatasetId"], name: "uq_dataset_project_client_id" }],
      true,
    );
    this.datasetVersion = new Model("datasetVersion", [
      { fields: ["datasetId", "versionNumber"], name: "uq_dataset_version_number" },
      { fields: ["datasetId", "idempotencyKey"], name: "uq_dataset_version_idempotency" },
    ]);
    this.testCase = new Model("testCase");
    this.evaluation = new Model(
      "evaluation",
      [{ fields: ["projectId", "evaluationKey"], name: "uq_evaluation_project_key" }],
      true,
    );
    this.evaluationRun = new Model(
      "evaluationRun",
      [
        { fields: ["evaluationId", "clientRunId"], name: "uq_run_client_run_id" },
        { fields: ["evaluationId", "runNumber"], name: "uq_run_evaluation_run_number" },
      ],
      true,
    );
    this.evaluationResult = new Model(
      "evaluationResult",
      [{ fields: ["runId", "testCaseId"], name: "uq_result_run_test_case" }],
      true,
    );
    this.score = new Model("score", [
      { fields: ["resultId", "scorerName", "scorerVersion"], name: "uq_score_result_scorer" },
    ]);
    this.humanScore = new Model("humanScore");
    this.wireRelations();
  }
}

/** Shared instance so the `@traceroot/core` mock and the test see one store. */
export const fakePrisma = new FakePrisma();
