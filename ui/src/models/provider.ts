import mongoose, { Schema, Model } from "mongoose";

export interface IAwsTraceConfig {
  region: string;
}

export interface ITencentTraceConfig {
  region: string;
  secretId: string;
  secretKey: string;
  apmInstanceId: string;
}

export interface IJaegerTraceConfig {
  endpoint: string;
}

export interface IAwsLogConfig {
  region: string;
}

export interface ITencentLogConfig {
  region: string;
  secretId: string;
  secretKey: string;
  clsTopicId: string;
}

export interface IJaegerLogConfig {
  endpoint: string;
}

export interface ITraceProviderConfig {
  userEmail: string;
  traceProvider?: "aws" | "tencent" | "jaeger";
  awsTraceConfig?: IAwsTraceConfig;
  tencentTraceConfig?: ITencentTraceConfig;
  jaegerTraceConfig?: IJaegerTraceConfig;
  createdAt: Date;
  updatedAt: Date;
}

export interface ILogProviderConfig {
  userEmail: string;
  logProvider?: "aws" | "tencent" | "jaeger";
  awsLogConfig?: IAwsLogConfig;
  tencentLogConfig?: ITencentLogConfig;
  jaegerLogConfig?: IJaegerLogConfig;
  createdAt: Date;
  updatedAt: Date;
}

const TraceProviderConfigSchema = new Schema<ITraceProviderConfig>(
  {
    userEmail: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    traceProvider: {
      type: String,
      enum: ["aws", "tencent", "jaeger"],
    },
    awsTraceConfig: {
      region: String,
    },
    tencentTraceConfig: {
      region: String,
      secretId: String,
      secretKey: String,
      apmInstanceId: String,
    },
    jaegerTraceConfig: {
      endpoint: String,
    },
  },
  {
    timestamps: true,
    collection: "trace_provider",
  },
);

const LogProviderConfigSchema = new Schema<ILogProviderConfig>(
  {
    userEmail: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    logProvider: {
      type: String,
      enum: ["aws", "tencent", "jaeger"],
    },
    awsLogConfig: {
      region: String,
    },
    tencentLogConfig: {
      region: String,
      secretId: String,
      secretKey: String,
      clsTopicId: String,
    },
    jaegerLogConfig: {
      endpoint: String,
    },
  },
  {
    timestamps: true,
    collection: "log_provider",
  },
);

// Prevent model recompilation in development
export const TraceProviderConfig: Model<ITraceProviderConfig> =
  mongoose.models.TraceProviderConfig ||
  mongoose.model<ITraceProviderConfig>(
    "TraceProviderConfig",
    TraceProviderConfigSchema,
    "trace_provider",
  );

export const LogProviderConfig: Model<ILogProviderConfig> =
  mongoose.models.LogProviderConfig ||
  mongoose.model<ILogProviderConfig>(
    "LogProviderConfig",
    LogProviderConfigSchema,
    "log_provider",
  );

export type {
  ITraceProviderConfig as ProviderTraceConfig,
  ILogProviderConfig as ProviderLogConfig,
};
