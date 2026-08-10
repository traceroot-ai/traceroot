-- Evaluation identity is SDK-agnostic: a run is not identified by which SDK produced it.
-- Drop the typed run provenance (git/CI/SDK identity + declared candidate model/prompt);
-- it is no longer captured by the SDKs, accepted by the contract, or surfaced in the UI.
ALTER TABLE "evaluation_runs" DROP COLUMN IF EXISTS "provenance";
