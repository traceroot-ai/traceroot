-- CreateTable
-- EdDSA signing keys for the better-auth jwt() plugin (private key signs the
-- CLI access JWTs; public key is served at /api/auth/jwks for offline verify).
CREATE TABLE "jwks" (
    "id" VARCHAR NOT NULL,
    "public_key" VARCHAR NOT NULL,
    "private_key" VARCHAR NOT NULL,
    "createdAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(6),

    CONSTRAINT "jwks_pkey" PRIMARY KEY ("id")
);
