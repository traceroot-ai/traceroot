/**
 * A tiny in-memory stand-in for the slice of Prisma the SDK reporting routes use,
 * so the real Route Handlers can be driven end to end without a database (this
 * repo never touches a real DB in tests).
 *
 * Deliberately row-oriented rather than call-count-oriented: the bugs these
 * routes shipped with were about *which rows survive a follow-up call*, which
 * assertions on mock arguments do not catch. Supports top-level-equality `where`
 * (including Prisma's compound-unique `{ a_b: { a, b } }` form), `create`,
 * `createMany`, `update`, `upsert`, `deleteMany`, `findFirst/findMany`, and an
 * interactive `$transaction` (same store, no rollback). `select` is ignored — the
 * row is returned whole.
 */
import { Prisma } from "@prisma/client";

export type Row = Record<string, unknown>;

/** The unique-constraint violation Prisma raises when two writers race. */
export function uniqueViolation(target: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    `Unique constraint failed on the fields: (${target})`,
    { code: "P2002", clientVersion: "5.22.0" },
  );
}

/** `{ runId_testCaseId: { runId, testCaseId } }` reads as plain column equality. */
function flatten(where: Row = {}): Row {
  const out: Row = {};
  for (const [key, value] of Object.entries(where)) {
    if (value !== null && typeof value === "object" && !(value instanceof Date)) {
      Object.assign(out, value as Row);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function matches(row: Row, where?: Row): boolean {
  return Object.entries(flatten(where)).every(([key, value]) => row[key] === value);
}

class Table {
  rows: Row[] = [];
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

  findFirst = async (args: { where?: Row } = {}) =>
    this.rows.find((row) => matches(row, args.where)) ?? null;

  findMany = async (args: { where?: Row } = {}) =>
    this.rows.filter((row) => matches(row, args.where));

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
    const row = this.rows.find((candidate) => matches(candidate, args.where));
    if (!row) throw new Error(`${this.prefix}: no row matches ${JSON.stringify(args.where)}`);
    Object.assign(row, args.data);
    return row;
  };

  upsert = async (args: { where: Row; create: Row; update: Row }) => {
    this.throwIfArmed();
    const row = this.rows.find((candidate) => matches(candidate, args.where));
    if (!row) return this.create({ data: args.create });
    Object.assign(row, args.update);
    return row;
  };

  deleteMany = async (args: { where?: Row } = {}) => {
    const before = this.rows.length;
    this.rows = this.rows.filter((row) => !matches(row, args.where));
    return { count: before - this.rows.length };
  };
}

export type EvalStore = {
  evaluationRun: Table;
  evaluationResult: Table;
  score: Table;
  $transaction: <T>(fn: (tx: EvalStore) => Promise<T>) => Promise<T>;
};

export function makeEvalStore(): EvalStore {
  const store = {
    evaluationRun: new Table("run"),
    evaluationResult: new Table("result"),
    score: new Table("score"),
    $transaction: <T>(fn: (tx: EvalStore) => Promise<T>): Promise<T> => fn(store),
  };
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
  });
  return {
    evaluationRun: model("evaluationRun"),
    evaluationResult: model("evaluationResult"),
    score: model("score"),
    $transaction: <T>(fn: (tx: EvalStore) => Promise<T>) => currentStore().$transaction(fn),
  };
}
