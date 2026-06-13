-- Add project scoped RCA provider and source columns for BYOK support
-- These track which provider and source (system|byok) the user selected
-- for the project's RCA agent model, so the worker can route correctly
-- without guessing from model name prefixes.

ALTER TABLE "projects" ADD COLUMN "rca_provider" VARCHAR;
ALTER TABLE "projects" ADD COLUMN "rca_source" VARCHAR;
