-- Add support for deterministic rule/code-based detectors alongside the
-- existing LLM-judge detectors. `type` discriminates evaluation mode;
-- `rule_config` carries the deterministic check definition for type="rule"
-- detectors and is unused (null) for type="llm" detectors.
ALTER TABLE "detectors" ADD COLUMN "type" VARCHAR NOT NULL DEFAULT 'llm';
ALTER TABLE "detectors" ADD COLUMN "rule_config" JSONB;