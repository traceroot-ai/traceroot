import mongoose, { Schema, Model } from "mongoose";

export interface IConnectionToken {
  user_email: string;
  token: string;
  token_type: string;
}

export interface ITracerootToken {
  token: string;
  user_email: string;
  user_sub: string;
  aws_access_key_id: string;
  aws_secret_access_key: string;
  aws_session_token: string;
  region: string;
  hash: string;
  expiration_utc: Date;
  otlp_endpoint: string;
  provider_type: string;
}

const ConnectionTokenSchema = new Schema<IConnectionToken>(
  {
    user_email: { type: String, required: true },
    token: { type: String, required: true },
    token_type: { type: String, required: true },
  },
  {
    collection:
      process.env.DB_CONNECTION_TOKENS_COLLECTION || "connection_tokens",
  },
);

const TracerootTokenSchema = new Schema<ITracerootToken>(
  {
    token: { type: String, required: true },
    user_email: { type: String, required: true },
    user_sub: { type: String, required: true },
    aws_access_key_id: { type: String, required: true },
    aws_secret_access_key: { type: String, required: true },
    aws_session_token: { type: String, required: true },
    region: { type: String, required: true },
    hash: { type: String, required: true },
    expiration_utc: { type: Date, required: true },
    otlp_endpoint: { type: String, required: true },
    provider_type: { type: String, required: true },
  },
  {
    collection:
      process.env.DB_TRACEROOT_TOKENS_COLLECTION || "traceroot_tokens",
    versionKey: false, // Disable __v field
  },
);

// Create compound index for user_email + token_type (matches Python implementation)
ConnectionTokenSchema.index({ user_email: 1, token_type: 1 }, { unique: true });

// Index on user_email for fast lookups, unique to ensure one token per user
TracerootTokenSchema.index({ user_email: 1 }, { unique: true });

export const ConnectionToken: Model<IConnectionToken> =
  mongoose.models.ConnectionToken ||
  mongoose.model<IConnectionToken>("ConnectionToken", ConnectionTokenSchema);

export const TracerootToken: Model<ITracerootToken> =
  mongoose.models.TracerootToken ||
  mongoose.model<ITracerootToken>("TracerootToken", TracerootTokenSchema);
