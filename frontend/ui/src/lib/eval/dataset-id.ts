import { createHash } from "crypto";

/**
 * Derive a dataset's stable client id (`ds_…`) from its key.
 *
 * MUST stay byte-identical to the SDK derivation (traceroot-py
 * `traceroot/eval/ids.py::stable_dataset_id`, traceroot-ts
 * `src/eval/ids.ts::stableDatasetId`): `"ds_" + sha256(key, utf-8).hex[:26]`,
 * lowercase hex, first 26 chars, key hashed verbatim (no normalization). This is
 * what lets a dataset authored in the UI and one pushed from the SDK under the
 * same key converge onto a single `(projectId, clientDatasetId)` identity.
 *
 * By convention the key defaults to the dataset's display name (see the SDK's
 * `key = key or name`), so a UI-created dataset uses its name as the key.
 */
export function stableDatasetId(key: string): string {
  const digest = createHash("sha256").update(key, "utf8").digest("hex");
  return `ds_${digest.slice(0, 26)}`;
}
