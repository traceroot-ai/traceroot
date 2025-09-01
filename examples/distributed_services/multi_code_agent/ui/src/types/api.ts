export interface Message {
  id: string;
  text: string;
  isUser: boolean;
  timestamp: Date;
}

export interface CodeApiRequest {
  query: string;
}

export interface CodeApiResponse {
  response?: string;
  error?: string;
}

export interface ChatState {
  messages: Message[];
  isLoading: boolean;
  isTracerootInitialized: boolean;
}
