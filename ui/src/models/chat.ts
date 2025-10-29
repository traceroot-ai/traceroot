import { ChatModel } from "@/constants/model";
import { ChatMode } from "@/constants/model";

export type MessageType = "assistant" | "user" | "github" | "statistics";
export type ActionType = "github_get_file" | "agent_chat";
export type ActionStatus = "pending" | "success" | "failed" | "cancelled";
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
}

export interface ChatMetadata {
  chat_id: string;
  timestamp: number;
  chat_title: string;
  trace_id: string;
}

export interface ChatMetadataHistory {
  history: ChatMetadata[];
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
