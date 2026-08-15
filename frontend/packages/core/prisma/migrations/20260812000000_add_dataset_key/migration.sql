-- Persist the SDK's dataset key (the pre-image of client_dataset_id = "ds_" +
-- sha256(key); by default key == name). Additive and nullable: existing rows and
-- older SDKs that omit it stay valid. Echoed back on dataset reads so a pulled
-- dataset recovers its true key and keeps case ids convergent when key != name.
-- No unique constraint — key -> client_dataset_id is deterministic, so identity is
-- already enforced by uq_dataset_project_client_id.
ALTER TABLE "datasets" ADD COLUMN "key" VARCHAR;
