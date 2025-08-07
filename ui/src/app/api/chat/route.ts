import { NextResponse } from 'next/server';
import { ActionType, ActionStatus, ChatRequest, ChatResponse, ChatbotResponse, MessageType } from '@/models/chat';

export async function POST(request: Request): Promise<NextResponse<ChatResponse>> {
  try {
    // Extract user_secret from Authorization header
    const authHeader = request.headers.get('authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      const errorResponse: ChatResponse = {
        success: false,
        data: null,
        error: 'Missing or invalid Authorization header. Expected: Bearer <user_secret>'
      };
      return NextResponse.json(errorResponse, { status: 401 });
    }

    const userSecret = authHeader.substring(7); // Remove 'Bearer ' prefix

    const body: ChatRequest = await request.json();
    const { time, message, message_type: messageType, trace_id, span_ids, start_time, end_time, model, mode, chat_id, provider } = body;
    const restApiEndpoint = process.env.REST_API_ENDPOINT;

    if (restApiEndpoint) {
      // Call the REST API endpoint
      try {
        const apiUrl = `${restApiEndpoint}/v1/explore/post-chat`;

        // Create the request body matching the ChatRequest structure from the REST API
        const apiRequestBody = {
          time,
          message,
          messageType,
          trace_id,
          span_ids,
          start_time,
          end_time,
          model,
          mode,
          chat_id,
          service_name: null,
          provider,
        };

        const apiResponse = await fetch(apiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${userSecret}`,
          },
          body: JSON.stringify(apiRequestBody),
        });

        if (!apiResponse.ok) {
          throw new Error(`REST API call failed with status: ${apiResponse.status}`);
        }

        const apiData = await apiResponse.json();

        // Transform the REST API response to match our ChatResponse format
        const chatbotResponse: ChatbotResponse = {
          time: apiData.time || new Date().toISOString(),
          message: apiData.message,
          reference: apiData.reference,
          message_type: 'assistant' as MessageType,
          chat_id: apiData.chat_id || chat_id,
          action_type: apiData.action_type,
          status: apiData.status,
        };

        const response: ChatResponse = {
          success: true,
          data: chatbotResponse
        };

        return NextResponse.json(response);
      } catch (apiError) {
        console.error('REST API call failed:', apiError);
        // Fall back to static response if REST API fails
        console.log('Falling back to static response due to API error');
      }
    }

    // Fallback to static response (original functionality)
    // This runs when either REST_API_ENDPOINT is not set or the API call fails
    await new Promise(resolve => setTimeout(resolve, 500));

    // Generate static response using the same logic from Agent.tsx
    const responseMessage = getStaticResponse(message, trace_id, span_ids);

    // Create response using Chat.ts models
    const chatbotResponse: ChatbotResponse = {
      time: new Date().getTime(),
      message: responseMessage,
      reference: [],
      message_type: 'assistant' as MessageType,
      chat_id: chat_id,
      action_type: 'agent_chat' as ActionType,
      status: 'success' as ActionStatus,
    };

    const response: ChatResponse = {
      success: true,
      data: chatbotResponse
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error('Chat API Error:', error);

    const errorResponse: ChatResponse = {
      success: false,
      data: null,
      error: 'Failed to process chat request'
    };

    return NextResponse.json(errorResponse, { status: 500 });
  }
}

function getStaticResponse(userInput: string, trace_id: string, span_ids: string[]): string {
  const hasTrace = Boolean(trace_id);
  const hasSpans = span_ids.length > 0;

  const responses = {
    noContext: `I notice you haven't selected any trace or spans yet. To help you better, please select a trace and specific spans you'd like to analyze.`,
    traceOnly: `I can see you're looking at trace ${trace_id}. To provide more detailed analysis, please select specific spans within this trace.`,
    spansOnly: `I see you've selected ${span_ids.length} spans, but no trace is selected. For better context, please select a trace as well.`,
    fullContext: `I'm analyzing trace ${trace_id} with ${span_ids.length} selected spans. What specific aspect would you like to know about these spans?`,
  };

  if (!hasTrace && !hasSpans) {
    return responses.noContext;
  } else if (hasTrace && !hasSpans) {
    return responses.traceOnly;
  } else if (!hasTrace && hasSpans) {
    return responses.spansOnly;
  } else {
    const input = userInput.toLowerCase();
    if (input.includes('error') || input.includes('fail')) {
      return `${responses.fullContext}\n\nI can help you analyze any errors or failures in these spans. Would you like to see the error rates or specific error messages?`;
    } else if (input.includes('time') || input.includes('duration') || input.includes('slow')) {
      return `${responses.fullContext}\n\nI can help you analyze the performance of these spans. Would you like to see the duration statistics or identify slow operations?`;
    } else if (input.includes('flow') || input.includes('sequence')) {
      return `${responses.fullContext}\n\nI can help you understand the flow of these spans. Would you like to see the sequence of operations or the dependencies between spans?`;
    } else {
      return `${responses.fullContext}\n\nI can help you analyze:\n- Performance metrics\n- Error patterns\n- Span relationships\n- Resource usage\nWhat would you like to know?`;
    }
  }
}
