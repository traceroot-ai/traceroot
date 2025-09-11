import { NextRequest, NextResponse } from 'next/server';
import * as traceroot from 'traceroot-sdk-ts';
import { request } from 'undici';

// Initialize traceroot with robust error handling
let tracerootInitialized = false;
let tracerootLogger: any = null;

async function initializeTraceRoot() {
  if (!tracerootInitialized) {
    try {
      // Initialize traceroot (using undici instead of fetch to avoid Next.js instrumentation)
      tracerootLogger = traceroot.get_logger();
      tracerootInitialized = true;
      console.log('🚀 TraceRoot initialized successfully in API route');
      if (tracerootLogger) {
        tracerootLogger.info('🚀 TraceRoot initialized successfully in API route');
      }
    } catch (error) {
      console.error('⚠️ TraceRoot initialization failed, continuing without tracing:', error);
      tracerootInitialized = false;
      tracerootLogger = null;
      // Don't throw - continue without TraceRoot
    }
  }
}

// Create a traced version of the request function
const makeTracedCodeRequest = async (query: string): Promise<any> => {
  try {
    console.log('📡 Making request to code agent:', { query });

    // Log with traceroot if available
    if (tracerootLogger) {
      tracerootLogger.info('📡 Making request to code agent', { query });
    }

    // Get trace headers if traceroot is available
    let traceHeaders = {};
    if (tracerootInitialized) {
      try {
        traceHeaders = traceroot.getTraceHeaders();
        const spanInfo = traceroot.getActiveSpanInfo();

        console.log('🔗 Trace Context:', {
          headerCount: Object.keys(traceHeaders).length,
          hasSpanInfo: !!spanInfo
        });

        if (tracerootLogger) {
          tracerootLogger.debug('🔗 Trace Context Debug', {
            spanInfo: JSON.stringify(spanInfo),
            traceHeaders: JSON.stringify(traceHeaders),
            headerCount: Object.keys(traceHeaders).length
          });
        }
      } catch (traceError) {
        console.warn('⚠️ Failed to get trace headers, continuing without:', traceError);
      }
    }

    // Use undici instead of fetch to avoid Next.js automatic instrumentation
    const { statusCode, headers: responseHeaders, body } = await request('http://localhost:9999/code', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...traceHeaders, // Spread trace headers if available
      },
      body: JSON.stringify({ query }),
    });

    // Convert undici response to fetch-like response
    const response = {
      ok: statusCode >= 200 && statusCode < 300,
      status: statusCode,
      json: async () => JSON.parse(await body.text()),
      text: async () => body.text(),
    };

    console.log('📡 Response status:', response.status);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('❌ Response error:', errorText);

      if (tracerootLogger) {
        tracerootLogger.error('❌ Code agent request failed', {
          status: response.status,
          error: errorText
        });
      }

      throw new Error(`HTTP error! status: ${response.status}, body: ${errorText}`);
    }

    const result = await response.json();
    console.log('✅ Code agent request completed:', {
      hasResponse: !!result.response,
      hasError: !!result.error
    });

    if (tracerootLogger) {
      tracerootLogger.info('✅ Code agent request completed', {
        hasResponse: !!result.response,
        hasError: !!result.error
      });
    }

    return result;
  } catch (error: any) {
    console.error('❌ Code agent request failed:', error.message);

    if (tracerootLogger) {
      tracerootLogger.error('❌ Code agent request failed', { error: error.message });
    }

    throw error;
  }
};

// Use traceFunction if traceroot is available, otherwise use regular function
function makeCodeRequest(query: string): Promise<any> {
  if (tracerootInitialized) {
    try {
      // Use traceFunction for proper span creation
      const tracedFunction = traceroot.traceFunction(
        makeTracedCodeRequest,
        { spanName: 'code_agent_request' }
      );
      return tracedFunction(query);
    } catch (traceError) {
      console.warn('⚠️ traceFunction failed, falling back to regular function:', traceError);
      return makeTracedCodeRequest(query);
    }
  }
  return makeTracedCodeRequest(query);
}

export async function POST(request: NextRequest) {
  try {
    // Initialize traceroot (non-blocking)
    await initializeTraceRoot();
    const body = await request.json();
    console.log('📄 Request body:', body);

    const { query } = body;

    if (!query) {
      console.log('❌ No query provided');
      return NextResponse.json(
        { error: 'Query parameter is required' },
        { status: 400 }
      );
    }

    console.log('🤖 Processing code generation request:', { query });

    if (tracerootLogger) {
      tracerootLogger.info('🤖 Received code generation request', { query });
    }

    // Make request to the code agent (with tracing if available)
    const result = await makeCodeRequest(query);

    console.log('✅ Returning result');
    return NextResponse.json(result);
  } catch (error: any) {
    console.error('❌ API route error:', error.message, error.stack);

    if (tracerootLogger) {
      tracerootLogger.error('❌ API route error', { error: error.message });
    }

    return NextResponse.json(
      { error: `Failed to process request: ${error.message}` },
      { status: 500 }
    );
  }
}

// Add a simple GET endpoint for testing
export async function GET() {
  try {
    // Initialize traceroot for status check
    await initializeTraceRoot();

    // Test connectivity to the code agent using undici (no Next.js instrumentation)
    const { statusCode } = await request('http://localhost:9999/code', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: 'test connection' }),
    });

    const testResponse = {
      ok: statusCode >= 200 && statusCode < 300,
      status: statusCode,
    };

    return NextResponse.json({
      message: 'Code Agent API Proxy with TraceRoot',
      status: 'ready',
      tracerootInitialized,
      codeAgentReachable: testResponse.ok,
      codeAgentStatus: testResponse.status
    });
  } catch (error: any) {
    return NextResponse.json({
      message: 'Code Agent API Proxy with TraceRoot',
      status: 'error',
      error: error.message,
      tracerootInitialized,
      codeAgentReachable: false
    });
  }
}
