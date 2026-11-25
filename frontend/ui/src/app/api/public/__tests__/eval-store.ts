/**
 * A tiny in-memory stand-in for the slice of Prisma the SDK reporting routes use,
 * so the real Route Handlers can be driven end to end without a database (this
 * repo never touches a real DB in tests).
 *
 * Deliberately row-oriented rather than call-count-oriented: the bugs these
 * routes shipped with were about *which rows survive a follow-up call*, which
 * assertions on mock arguments do not catch. Supports top-level-equality `where`
 * (including Prisma's compound-unique `{ a_b: { a, b } }` form, `{ not: value }`,
 * and a filter through a relation: `{ scores: { some: {...} } }` on a result,
 * `{ result: {...} }` on a score; any other relation operator throws), `create`,
 * `createMany`, `update`, `upsert`, `deleteMany`, `count`, `findFirst/findMany`,
 * and an interactive `$transaction` (same store, no rollback). A `null` in `where`
 * matches an absent column, as SQL NULL does. `select` is ignored — the row is
 * returned whole. `$queryRaw` answers no rows: the routes use it only to lock a
 * row, and one in-memory store has no concurrent transaction to lock it against.
 */
import { Prisma } from "@prisma/client";

export type Row = Record<string, unknown>;

/** The rows on the other side of a relation a `where` can filter through. */
type Related = (row: Row) => Row[];

/** The unique-constraint violation Prisma raises when two writers race. */
export function uniqueViolation(target: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    `Unique constraint failed on the fields: (${target})`,
    { code: "P2002", clientVersion: "5.22.0" },
  );
}

const isObject = (value: unknown): value is Row =>
  value !== null && typeof value === "object" && !(value instanceof Date);

/** Column equality, where `null` also matches a column the row never set. */
const same = (actual: unknown, expected: unknown) =>
  expected === null ? actual == null : actual === expected;

/** Relation filter operators `matches` does not implement; one throws rather than mis-match. */
const UNSUPPORTED_RELATION_OPERATORS = ["none", "every", "is", "isNot"];

function matches(row: Row, where: Row = {}, relations: Record<string, Related> = {}): boolean {
  return Object.entries(where).every(([key, value]) => {
    const related = relations[key];
    if (related) {
      const filter = value as Row;
      if (Object.keys(filter).some((op) => UNSUPPORTED_RELATION_OPERATORS.includes(op))) {
        throw new Error(
          `eval-store: unsupported relation filter on ${key}: ${JSON.stringify(filter)}`,
        );
      }
      return related(row).some((other) =>
        matches(other, isObject(filter.some) ? filter.some : filter),
      );
    }
    if (isObject(value) && "not" in value) return !same(row[key], value.not);
    // `{ runId_testCaseId: { runId, testCaseId } }` reads as plain column equality.
    if (isObject(value)) return matches(row, value);
    return same(row[key], value);
  });
}

class Table {
  rows: Row[] = [];
  /** Relations a `where` can filter through, keyed by the relation's field name. */
  relations: Record<string, Related> = {};
  private seq = 0;
  private failure: unknown;

  constructor(private prefix: string) {}

  /** Makes the next write reject — used to drive the routes' P2002 retry path. */
  failNextWrite(error: unknown) {
    this.failure = error;
  }

  private throwIfArmed() {
    const failure = this.failure;
    this.failure = undefined;
    if (failure) throw failure;
  }

  private matches(row: Row, where?: Row) {
    return matches(row, where, this.relations);
  }

  findFirst = async (args: { where?: Row } = {}) =>
    this.rows.find((row) => this.matches(row, args.where)) ?? null;

  findMany = async (args: { where?: Row } = {}) =>
    this.rows.filter((row) => this.matches(row, args.where));

  count = async (args: { where?: Row } = {}) =>
    this.rows.filter((row) => this.matches(row, args.where)).length;

  create = async (args: { data: Row }) => {
    this.throwIfArmed();
    this.seq += 1;
    const row: Row = { id: `${this.prefix}-${this.seq}`, ...args.data };
    this.rows.push(row);
    return row;
  };

  createMany = async (args: { data: Row[] }) => {
    for (const data of args.data) await this.create({ data });
    return { count: args.data.length };
  };

  update = async (args: { where: Row; data: Row }) => {
    this.throwIfArmed();
    const row = this.rows.find((candidate) => this.matches(candidate, args.where));
    if (!row) throw new Error(`${this.prefix}: no row matches ${JSON.stringify(args.where)}`);
    Object.assign(row, args.data);
    return row;
  };

  upsert = async (args: { where: Row; create: Row; update: Row }) => {
    this.throwIfArmed();
    const row = this.rows.find((candidate) => this.matches(candidate, args.where));
    if (!row) return this.create({ data: args.create });
    Object.assign(row, args.update);
    return row;
  };

  deleteMany = async (args: { where?: Row } = {}) => {
    const before = this.rows.length;
    this.rows = this.rows.filter((row) => !this.matches(row, args.where));
    return { count: before - this.rows.length };
  };
}

export type EvalStore = {
  evaluationRun: Table;
  evaluationResult: Table;
  score: Table;
  $transaction: <T>(fn: (tx: EvalStore) => Promise<T>) => Promise<T>;
  $queryRaw: (...args: unknown[]) => Promise<Row[]>;
};

export function makeEvalStore(): EvalStore {
  const store = {
    evaluationRun: new Table("run"),
    evaluationResult: new Table("result"),
    score: new Table("score"),
    $transaction: <T>(fn: (tx: EvalStore) => Promise<T>): Promise<T> => fn(store),
    $queryRaw: async (): Promise<Row[]> => [],
  };
  store.evaluationResult.relations.scores = (result) =>
    store.score.rows.filter((score) => score.resultId === result.id);
  store.score.relations.result = (score) =>
    store.evaluationResult.rows.filter((result) => result.id === score.resultId);
  return store;
}

type ModelName = "evaluationRun" | "evaluationResult" | "score";

/**
 * The object a test hands to `vi.mock("@traceroot/core")` in place of `prisma`.
 * It resolves the store on every call, so a test file can hand out one facade at
 * module-mock time and still start each case from a fresh store.
 */
export function prismaFacade(currentStore: () => EvalStore) {
  const model = (name: ModelName) => ({
    findFirst: (args?: { where?: Row }) => currentStore()[name].findFirst(args),
    findMany: (args?: { where?: Row }) => currentStore()[name].findMany(args),
    create: (args: { data: Row }) => currentStore()[name].create(args),
    createMany: (args: { data: Row[] }) => currentStore()[name].createMany(args),
    update: (args: { where: Row; data: Row }) => currentStore()[name].update(args),
    upsert: (args: { where: Row; create: Row; update: Row }) => currentStore()[name].upsert(args),
    deleteMany: (args?: { where?: Row }) => currentStore()[name].deleteMany(args),
    count: (args?: { where?: Row }) => currentStore()[name].count(args),
  });
  return {
    evaluationRun: model("evaluationRun"),
    evaluationResult: model("evaluationResult"),
    score: model("score"),
    $transaction: <T>(fn: (tx: EvalStore) => Promise<T>) => currentStore().$transaction(fn),
  };
}
