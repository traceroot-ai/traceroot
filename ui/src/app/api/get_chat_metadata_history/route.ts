import { NextResponse } from 'next/server';
import { GetChatMetadataHistoryRequest, ChatMetadataHistory } from '@/models/chat';

export async function GET(request: Request): Promise<NextResponse<ChatMetadataHistory>> {
  try {
    const url = new URL(request.url);
    const trace_id = url.searchParams.get('trace_id');

    if (!trace_id) {
      return NextResponse.json(
        { history: [] } as ChatMetadataHistory,
        { status: 400 }
      );
    }

    // Extract user_secret from Authorization header
    const authHeader = request.headers.get('authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return NextResponse.json(
        { history: [] } as ChatMetadataHistory,
        { status: 401 }
      );
    }

    const userSecret = authHeader.substring(7); // Remove 'Bearer ' prefix

    const restApiEndpoint = process.env.REST_API_ENDPOINT;

    if (restApiEndpoint) {
      try {
        const apiUrl = `${restApiEndpoint}/v1/explore/get-chat-metadata-history?trace_id=${encodeURIComponent(trace_id)}`;
        const apiResponse = await fetch(apiUrl, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${userSecret}`,
          },
        });

        if (!apiResponse.ok) {
          throw new Error(`REST API call failed with status: ${apiResponse.status}`);
        }

        const apiData: ChatMetadataHistory = await apiResponse.json();

        // Convert timestamp from Python datetime string to number for consistency
        const processedData: ChatMetadataHistory = {
          history: apiData.history.map(item => ({
            ...item,
            timestamp: typeof item.timestamp === 'string'
              ? new Date(item.timestamp).getTime()
              : item.timestamp
          }))
        };

        return NextResponse.json(processedData);
      } catch (apiError) {
        console.error('REST API call failed:', apiError);
        // Fall back to empty response if REST API fails
        console.log('Falling back to empty response due to API error');
      }
    }

    // Fallback to empty response when REST_API_ENDPOINT is not set or API call fails
    const fallbackResponse: ChatMetadataHistory = {
      history: []
    };

    return NextResponse.json(fallbackResponse);
  } catch (error) {
    console.error('Get Chat Metadata History API Error:', error);

    const errorResponse: ChatMetadataHistory = {
      history: []
    };

    return NextResponse.json(errorResponse, { status: 500 });
  }
}
