-- Index the device-code expiry so expired rows can be pruned cheaply and the
-- hot verify/poll lookups stay bounded.
CREATE INDEX "ix_device_code_expires_at" ON "device_codes"("expires_at");
