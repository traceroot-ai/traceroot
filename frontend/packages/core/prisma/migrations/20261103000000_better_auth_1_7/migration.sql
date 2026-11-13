BEGIN;
SET LOCAL lock_timeout = '5s';

-- better-auth 1.7's jwt() plugin records each key's algorithm and curve.
-- Existing rows keep NULL, which better-auth reads as the configured
-- keyPairConfig (EdDSA / Ed25519).
ALTER TABLE "jwks" ADD COLUMN "alg" VARCHAR;
ALTER TABLE "jwks" ADD COLUMN "crv" VARCHAR;

-- better-auth 1.7 expects deviceCode and userCode to be unique. Expired codes
-- can no longer be polled or approved, so drop them first; a code that was
-- reused after expiring would otherwise block the unique index.
DELETE FROM "device_codes" WHERE "expires_at" < CURRENT_TIMESTAMP;

DROP INDEX "ix_device_code_device_code";
DROP INDEX "ix_device_code_user_code";
CREATE UNIQUE INDEX "uq_device_code_device_code" ON "device_codes"("device_code");
CREATE UNIQUE INDEX "uq_device_code_user_code" ON "device_codes"("user_code");

COMMIT;
