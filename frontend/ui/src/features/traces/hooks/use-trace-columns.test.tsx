// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { FixedColumnId } from "@/features/traces/columns";
import { useTraceColumns } from "./use-trace-columns";

/** The per-project entry the design names, spelled out rather than imported from the module
 * under test: a key the hook renames is a key every open tab loses, so it is pinned here. */
const columnsKey = (projectId: string) => `traceroot:traces:columns:v1:${projectId}`;

// Spelled out rather than derived from the registry, so that a change to the registry fails
// here and gets looked at instead of being quietly absorbed by the expectation.
const COLUMNS_BEFORE_OPT_INS: FixedColumnId[] = [
  "timestamp",
  "name",
  "trace_id",
  "errors",
  "spans",
  "input",
  "output",
];
const COLUMNS_AFTER_OPT_INS: FixedColumnId[] = ["tokens", "cost", "latency"];
/** The ten shown by default, in registry order. The rest of the registry is opt-in. */
const DEFAULT_VISIBLE_COLUMNS: FixedColumnId[] = [
  ...COLUMNS_BEFORE_OPT_INS,
  ...COLUMNS_AFTER_OPT_INS,
];

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(cleanup);

/** Render the hook the way the traces page wires it: a project id and nothing else. The stored
 * entry is the hook's only input, so every test sets up through storage or the hook's mutators. */
function renderColumns(projectId = "p-1") {
  return renderHook(() => useTraceColumns(projectId));
}

describe("useTraceColumns", () => {
  it("starts with the ten default columns", () => {
    const { result } = renderColumns();
    expect(result.current.visibleColumns).toEqual(DEFAULT_VISIBLE_COLUMNS);
  });

  describe("toggling a column", () => {
    it("shows an opt-in column at its registry position and hides it again", () => {
      const { result } = renderColumns();

      act(() => result.current.toggleField("user_id"));
      expect(result.current.visibleColumns).toEqual([
        ...COLUMNS_BEFORE_OPT_INS,
        "user_id",
        ...COLUMNS_AFTER_OPT_INS,
      ]);

      act(() => result.current.toggleField("user_id"));
      expect(result.current.visibleColumns).toEqual(DEFAULT_VISIBLE_COLUMNS);
    });

    it("hides a column that is on by default and shows it again", () => {
      // The half of the picker that is new: the ten that used to be permanent are toggles
      // like any other, so the same call has to work in the hiding direction too.
      const { result } = renderColumns();

      act(() => result.current.toggleField("input"));
      expect(result.current.visibleColumns).toEqual(
        DEFAULT_VISIBLE_COLUMNS.filter((id) => id !== "input"),
      );

      act(() => result.current.toggleField("input"));
      expect(result.current.visibleColumns).toEqual(DEFAULT_VISIBLE_COLUMNS);
    });

    it("resolves the visible columns in registry order however they were toggled", () => {
      const { result } = renderColumns();

      act(() => result.current.toggleField("session_id"));
      act(() => result.current.toggleField("user_id"));

      expect(result.current.visibleColumns).toEqual([
        ...COLUMNS_BEFORE_OPT_INS,
        "user_id",
        "session_id",
        ...COLUMNS_AFTER_OPT_INS,
      ]);
    });
  });

  describe("reset to default", () => {
    it("restores the ten defaults, bringing hidden columns back and dropping added ones", () => {
      const { result } = renderColumns();
      act(() => result.current.toggleField("user_id"));
      act(() => result.current.toggleField("input"));

      act(() => result.current.reset());

      expect(result.current.visibleColumns).toEqual(DEFAULT_VISIBLE_COLUMNS);
    });
  });

  describe("persistence", () => {
    it("restores an added column for the same project on the next load", () => {
      const first = renderColumns();
      act(() => first.result.current.toggleField("session_id"));
      cleanup();

      const { result } = renderColumns();
      expect(result.current.visibleColumns).toEqual([
        ...COLUMNS_BEFORE_OPT_INS,
        "session_id",
        ...COLUMNS_AFTER_OPT_INS,
      ]);
    });

    it("restores a hidden default column as hidden on the next load", () => {
      const first = renderColumns();
      act(() => first.result.current.toggleField("cost"));
      cleanup();

      const { result } = renderColumns();
      expect(result.current.visibleColumns).toEqual(
        DEFAULT_VISIBLE_COLUMNS.filter((id) => id !== "cost"),
      );
    });

    it("keeps each project's column set to itself", () => {
      const first = renderColumns();
      act(() => first.result.current.toggleField("cost"));
      cleanup();

      const { result } = renderColumns("p-2");
      expect(result.current.visibleColumns).toEqual(DEFAULT_VISIBLE_COLUMNS);
    });

    it("writes deviations from the default, not the visible set, to the stored entry", () => {
      // Storing flips rather than the visible set is why a column added to the registry later
      // shows up for existing users without a migration: `input` is here for being hidden.
      const { result } = renderColumns();
      act(() => result.current.toggleField("user_id"));
      act(() => result.current.toggleField("input"));

      const raw = window.localStorage.getItem(columnsKey("p-1"));
      expect(raw).not.toBeNull();
      expect(JSON.parse(raw as string)).toMatchObject({ fields: ["user_id", "input"] });
    });
  });

  describe("a stored entry", () => {
    // `fields` holds the ids FLIPPED from the registry default, not the ids shown: a shown-set
    // reading would leave a user with the columns their entry names and none of the defaults.
    function writeEntry(fields: string[]) {
      window.localStorage.setItem(columnsKey("p-1"), JSON.stringify({ version: 1, fields }));
    }

    it("shows both default-off columns an entry names, at their registry positions", () => {
      writeEntry(["session_id", "user_id"]);

      const { result } = renderColumns();

      expect(result.current.visibleColumns).toEqual([
        ...COLUMNS_BEFORE_OPT_INS,
        "user_id",
        "session_id",
        ...COLUMNS_AFTER_OPT_INS,
      ]);
    });

    it("hides a default-on column its entry names, and keeps the rest of the defaults", () => {
      // The direction that tells a flip list from a shown list: `input` is on by default, so
      // naming it means hidden, where a shown-set reading would leave it and `user_id` alone.
      writeEntry(["input", "user_id"]);

      const { result } = renderColumns();

      expect(result.current.visibleColumns).toEqual([
        ...COLUMNS_BEFORE_OPT_INS.filter((id) => id !== "input"),
        "user_id",
        ...COLUMNS_AFTER_OPT_INS,
      ]);
    });

    it("keeps the fields of an entry that still carries a retired metadata list", () => {
      // Forward compatibility: entries carrying the retired per-key `metadata` list are still
      // on disk, and voiding them would reset the field choices of everyone who has one.
      window.localStorage.setItem(
        columnsKey("p-1"),
        JSON.stringify({ version: 1, fields: ["user_id"], metadata: ["tenant"] }),
      );

      const { result } = renderColumns();

      expect(result.current.visibleColumns).toEqual([
        ...COLUMNS_BEFORE_OPT_INS,
        "user_id",
        ...COLUMNS_AFTER_OPT_INS,
      ]);
    });
  });

  describe("hand-edited or stale storage", () => {
    it.each([
      ["an entry that is not an object", '"user_id"'],
      ["a bare array", JSON.stringify(["user_id"])],
      ["unparseable JSON", "{not json"],
      ["an entry whose list is not an array", JSON.stringify({ version: 1, fields: "user_id" })],
    ])("reads %s as no deviations from the defaults", (_case, raw) => {
      window.localStorage.setItem(columnsKey("p-1"), raw);

      const { result } = renderColumns();

      expect(result.current.visibleColumns).toEqual(DEFAULT_VISIBLE_COLUMNS);
    });

    it("reads a repeated id as one column", () => {
      // The table renders one column per entry, so a repeat becomes two identical headers
      // over two identical cells. First occurrence wins, leaving the user's order untouched.
      window.localStorage.setItem(
        columnsKey("p-1"),
        JSON.stringify({ version: 1, fields: ["user_id", "session_id", "user_id"] }),
      );

      const { result } = renderColumns();

      expect(result.current.visibleColumns).toEqual([
        ...COLUMNS_BEFORE_OPT_INS,
        "user_id",
        "session_id",
        ...COLUMNS_AFTER_OPT_INS,
      ]);
    });

    it("ignores a stored id that is not a column, and honours the ones that are", () => {
      // An id dropped from the registry, or a hand-edited entry, must read as "not a
      // column" rather than reaching the table as an empty header.
      window.localStorage.setItem(
        columnsKey("p-1"),
        JSON.stringify({ version: 1, fields: ["user_id", "not_a_column"] }),
      );

      const { result } = renderColumns();

      expect(result.current.visibleColumns).toEqual([
        ...COLUMNS_BEFORE_OPT_INS,
        "user_id",
        ...COLUMNS_AFTER_OPT_INS,
      ]);
    });

    it("cleans up an entry another tab writes while this list is open", () => {
      // The hook is not the only writer — the key is live in every tab on the project — so the
      // read is the gate, and the duplicate and the number are gone before the table sees them.
      const { result } = renderColumns();
      expect(result.current.visibleColumns).toEqual(DEFAULT_VISIBLE_COLUMNS);

      act(() => {
        window.localStorage.setItem(
          columnsKey("p-1"),
          JSON.stringify({ version: 1, fields: ["user_id", "user_id", 7] }),
        );
        window.dispatchEvent(
          new StorageEvent("storage", {
            key: columnsKey("p-1"),
            storageArea: window.localStorage,
          }),
        );
      });

      expect(result.current.visibleColumns).toEqual([
        ...COLUMNS_BEFORE_OPT_INS,
        "user_id",
        ...COLUMNS_AFTER_OPT_INS,
      ]);
    });
  });
});
