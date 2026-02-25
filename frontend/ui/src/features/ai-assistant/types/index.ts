export interface AIMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  isStreaming?: boolean;
}

export interface AISession {
  id: string;
  projectId: string;
  title: string | null;
  status: string;
  createTime: string;
}
