import { ChatModel } from "@/constants/model";
import { ChatMode } from "@/constants/model";
import mongoose, { Model, Schema } from "mongoose";

export type MessageType = "assistant" | "user" | "github" | "statistics";
export type ActionType =
  | "github_get_file"
  | "agent_chat"
  | "pending_confirmation"
  | "github_create_issue"
  | "github_create_pr";
export type ActionStatus =
  | "pending"
  | "success"
  | "failed"
  | "cancelled"
  | "awaiting_confirmation";
export type Provider = "openai" | "custom";

export interface Reference {
  number: number;
  span_id?: string;
  span_function_name?: string;
  line_number?: number;
  log_message?: string;
}

export interface ChatRequest {
  time: number;
  message: string;
  message_type: MessageType;
  trace_id: string;
  span_ids: string[];
  start_time: number;
  end_time: number;
  model: ChatModel;
  mode: ChatMode;
  chat_id: string;
  trace_provider: string;
  log_provider: string;
  trace_region?: string;
  log_region?: string;
  provider: Provider;
}

export interface ChatbotResponse {
  time: number;
  message: string;
  reference: Reference[];
  message_type: MessageType;
  chat_id: string;
  action_type?: ActionType;
  status?: ActionStatus;
}

export interface ChatResponse {
  success: boolean;
  data: ChatbotResponse | null;
  error?: string;
}

export interface ChatMetadata {
  chat_id: string;
  timestamp: number;
  chat_title: string;
  trace_id: string;
  user_id?: string;
}

export interface ChatMetadataHistory {
  history: ChatMetadata[];
  hasMore?: boolean;
}

export interface GetChatMetadataHistoryRequest {
  trace_id: string;
}

export interface GetChatMetadataRequest {
  chat_id: string;
}

export interface GetChatHistoryRequest {
  chat_id: string;
}

export interface ChatHistoryResponse {
  history: ChatbotResponse[];
}

// Note: These interfaces were originally part of PR #276 but are kept because newer code depends on them
export interface ConfirmActionRequest {
  chat_id: string;
  message_timestamp: number;
  confirmed: boolean;
}

export interface ConfirmActionResponse {
  success: boolean;
  message: string;
  data?: Record<string, any>;
}

// Backward compatibility aliases
export type ConfirmGitHubActionRequest = ConfirmActionRequest;
export type ConfirmGitHubActionResponse = ConfirmActionResponse;

// Mongoose model for reasoning_streams collection
// Note: This was originally part of PR #276 but is kept because newer code depends on it
export interface IReasoningRecord {
  chat_id: string;
  chunk_id: number;
  content: string;
  status: string;
  timestamp: Date;
  trace_id?: string;
}

const ReasoningRecordSchema = new Schema<IReasoningRecord>(
  {
    chat_id: { type: String, required: true },
    chunk_id: { type: Number, required: true },
    content: { type: String, required: true },
    status: { type: String, required: true },
    timestamp: { type: Date, required: true },
    trace_id: { type: String, required: false },
  },
  {
    collection: process.env.DB_REASONING_COLLECTION || "reasoning_streams",
    versionKey: false,
  },
);

// Index on chat_id for fast lookups
ReasoningRecordSchema.index({ chat_id: 1 });

export const ReasoningRecordModel: Model<IReasoningRecord> =
  mongoose.models.ReasoningRecordModel ||
  mongoose.model<IReasoningRecord>(
    "ReasoningRecordModel",
    ReasoningRecordSchema,
  );
