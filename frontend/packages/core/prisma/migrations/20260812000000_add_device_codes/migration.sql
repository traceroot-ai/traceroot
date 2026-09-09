-- CreateTable
CREATE TABLE "device_codes" (
    "id" VARCHAR NOT NULL,
    "device_code" VARCHAR NOT NULL,
    "user_code" VARCHAR NOT NULL,
    "user_id" VARCHAR,
    "expires_at" TIMESTAMP(6) NOT NULL,
    "status" VARCHAR NOT NULL,
    "last_polled_at" TIMESTAMP(6),
    "polling_interval" INTEGER,
    "client_id" VARCHAR,
    "scope" VARCHAR,
    "createdAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "device_codes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ix_device_code_device_code" ON "device_codes"("device_code");

-- CreateIndex
CREATE INDEX "ix_device_code_user_code" ON "device_codes"("user_code");
