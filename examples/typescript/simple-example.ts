import * as traceroot from 'traceroot-sdk-ts';

const logger = traceroot.getLogger();

async function main() {
  const makeRequest = traceroot.traceFunction(
    async function makeRequest(requestId: string, userId: string): Promise<string> {
      // This will store the userId as a metadata attribute in the span so you can search for it in the TraceRoot UI
      logger.info({ userId }, `Making request: ${requestId}`, { userId });
      logger.debug('Pure debug message');
      await makeAnotherRequest(requestId, userId);
      // Simulate some async work
      await new Promise(resolve => setTimeout(resolve, 1000));
      return `Request ${requestId} completed`;
    },
    { spanName: 'makeRequest', traceParams: true }
  );
  const result = await makeRequest('123', 'user123');
  logger.info(`Request result: ${result}`); // This will not be shown in TraceRoot UI
}

async function makeAnotherRequest(requestId: string, userId: string) {
  await new Promise(resolve => setTimeout(resolve, 1000));
  // This will store the requestId and userId as a metadata attribute in the span so you can search for it in the TraceRoot UI
  logger.info({ userId, requestId }, `Making another request`);
}

main().then(async () => {
  await traceroot.forceFlushTracer();
  await traceroot.shutdownTracer();
  await traceroot.forceFlushLogger();
  await traceroot.shutdownLogger();
  process.exit(0);
});
