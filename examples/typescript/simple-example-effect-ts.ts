/**
 * Effect-TS Integration Example with TraceRoot
 *
 * This example demonstrates how to integrate TraceRoot tracing and logging
 * with Effect-TS, showing both approaches:
 * 1. Using TraceRoot's traceFunction with Effect
 * 2. Using Effect's native tracing capabilities
 *
 * Run with: npm run example:effect
 */

import { Effect, Console, Duration } from 'effect';
import * as traceroot from '../src/index';

// Get the TraceRoot logger
const logger = traceroot.getLogger();

// Effect to simulate async work with delay
const delay = (ms: number) => Effect.sleep(Duration.millis(ms));

// Effect for making another request
const makeAnotherRequest = (requestId: string, userId: string) =>
  Effect.gen(function* () {
    yield* delay(1000);
    // This will store the requestId and userId as metadata attributes in the span
    logger.info({ userId, requestId }, `Making another request`);
    yield* Console.log(`Another request completed for ${requestId}`);
  });

// Main request effect with tracing
const makeRequestEffect = (requestId: string, userId: string) =>
  Effect.gen(function* () {
    // This will store the userId as a metadata attribute in the span
    logger.info({ userId }, `Making request: ${requestId}`, { userId });
    logger.debug('Pure debug message');

    yield* Console.log(`Processing request ${requestId} for user ${userId}`);

    // Call the nested request
    yield* makeAnotherRequest(requestId, userId);

    // Simulate some async work
    yield* delay(1000);

    const result = `Request ${requestId} completed`;
    yield* Console.log(`Request processing finished: ${result}`);

    return result;
  });

// Wrap the Effect with TraceRoot tracing
const tracedMakeRequest = (requestId: string, userId: string) => {
  const wrappedFunction = traceroot.traceFunction(
    async (reqId: string, usrId: string): Promise<string> => {
      // Run the Effect and extract the result
      return await Effect.runPromise(makeRequestEffect(reqId, usrId));
    },
    { spanName: 'makeRequest', traceParams: true }
  );

  return Effect.promise(() => wrappedFunction(requestId, userId));
};

// Main program effect
const program = Effect.gen(function* () {
  yield* Console.log('Starting Effect-TS TraceRoot example...');

  // Execute the traced request
  const result = yield* tracedMakeRequest('123', 'user123');

  // This log will not be shown in TraceRoot UI as it's outside the traced function
  logger.info(`Request result: ${result}`);
  yield* Console.log(`Final result: ${result}`);

  return result;
});

// Cleanup effect
const cleanup = Effect.gen(function* () {
  yield* Console.log('Cleaning up TraceRoot...');
  yield* Effect.promise(() => traceroot.forceFlushTracer());
  yield* Effect.promise(() => traceroot.shutdownTracer());
  yield* Effect.promise(() => traceroot.forceFlushLogger());
  yield* Effect.promise(() => traceroot.shutdownLogger());
  yield* Console.log('Cleanup completed');
});

// Main effect that runs the program and handles cleanup
const main = Effect.gen(function* () {
  yield* program;
}).pipe(Effect.ensuring(cleanup));

// Alternative approach: Using Effect's tracing directly
// This shows how you could integrate more deeply with Effect's built-in tracing
const makeRequestWithEffectTracing = (requestId: string, userId: string) =>
  Effect.gen(function* () {
    yield* Effect.logInfo(`Making request: ${requestId}`);
    yield* Effect.logDebug('Pure debug message');

    yield* Console.log(`Processing request ${requestId} for user ${userId}`);

    // Use Effect's withSpan for native Effect tracing
    const nestedRequest = Effect.gen(function* () {
      yield* delay(1000);
      yield* Effect.logInfo(`Making another request for ${requestId}`);
      yield* Console.log(`Another request completed for ${requestId}`);
    }).pipe(Effect.withSpan('makeAnotherRequest'));

    yield* nestedRequest;
    yield* delay(1000);

    const result = `Request ${requestId} completed`;
    yield* Effect.logInfo(`Request completed: ${result}`);

    return result;
  }).pipe(Effect.withSpan('makeRequest', { attributes: { requestId, userId } }));

// Alternative program using Effect's native tracing
const programWithEffectTracing = Effect.gen(function* () {
  yield* Console.log('Starting Effect-TS with native tracing example...');

  const result = yield* makeRequestWithEffectTracing('456', 'user456');

  yield* Console.log(`Final result with Effect tracing: ${result}`);

  return result;
});

// Run the main program
if (require.main === module) {
  // Choose which example to run:
  // - main: Uses TraceRoot's traceFunction with Effect
  // - programWithEffectTracing: Uses Effect's native tracing
  const exampleToRun = main; // Change to programWithEffectTracing for the alternative

  Effect.runPromise(exampleToRun)
    .then(() => {
      console.log('Effect-TS TraceRoot example completed successfully!');
      process.exit(0);
    })
    .catch(error => {
      console.error('Effect-TS TraceRoot example failed:', error);
      process.exit(1);
    });
}

// Export effects for potential reuse
export {
  makeRequestEffect,
  tracedMakeRequest,
  makeRequestWithEffectTracing,
  program,
  programWithEffectTracing,
  main,
};
