import * as traceroot from '../src/index';

const logger = traceroot.getLogger();

class GreetingService {
  // @ts-ignore - TypeScript has strict typing issues with decorators, but this works at runtime
  @traceroot.trace({ spanName: 'greet' })
  async greet(name: string): Promise<string> {
    logger.info(`Greeting inside traced function: ${name}`);
    // Simulate some async work
    await new Promise(resolve => setTimeout(resolve, 100));
    return `Hello, ${name}!`;
  }
}

async function main() {
  const service = new GreetingService();
  const result = await service.greet('world');
  logger.info(`Greeting result: ${result}`); // This will not be shown in TraceRoot UI
}

main().then(async () => {
  await traceroot.forceFlushTracer();
  await traceroot.shutdownTracer();
  await traceroot.forceFlushLogger();
  await traceroot.shutdownLogger();
  process.exit(0);
});
