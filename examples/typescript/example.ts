import * as traceroot from '../src/index';

class TraceRootExample {
  private logger = traceroot.getLogger();
  constructor() {
    this.processData = traceroot.traceFunction(this.processData.bind(this));
    this.delay = traceroot.traceFunction(this.delay.bind(this), { spanName: 'delay_execution' });
    this.calculateSum = traceroot.traceFunction(this.calculateSum.bind(this), {
      traceParams: true,
      traceReturnValue: true,
    });
    this.simulateError = traceroot.traceFunction(this.simulateError.bind(this), {
      spanName: 'error_simulation',
    });
    this.runExample = traceroot.traceFunction(this.runExample.bind(this), {
      spanName: 'run_example_orchestrator',
    });
  }

  async processData(data: string, count: number): Promise<string> {
    // Simulate some work
    await this.delay(100);
    const result = `Processed: ${data} (${count} times)`;
    this.logger.info('✅ Async processing result in processData: ' + result);
    return result;
  }

  async delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  calculateSum(numbers: number[]): number {
    this.logger.info('🔢 Starting sum calculation in calculateSum: ' + numbers.join(', '));
    const sum = numbers.reduce((acc, num) => {
      return acc + num;
    }, 0);
    this.logger.info('✅ Sum calculation completed in calculateSum: ' + sum);
    return sum;
  }

  async simulateError(): Promise<void> {
    try {
      throw new Error('This is a simulated error for testing');
    } catch (_error: any) {
      this.logger.error('✅ Caught expected error in simulateError: ' + _error.message);
    }
  }

  async runExample(): Promise<void> {
    try {
      this.logger.info({ requestId: '123' }, '🚀 Starting example');

      // Example 1: Async function with tracing and parameter tracking
      const result1 = await this.processData('test-data', 5);
      this.logger.info('✅ Processed data in runExample', { result: result1 });

      // Example 2: Sync function with tracing and return value tracking
      const numbers = [1, 2, 3, 4, 5];
      const sum = this.calculateSum(numbers);
      this.logger.info('✅ Sum calculation completed in runExample: ' + sum);

      // Example 3: Error handling with tracing
      try {
        await this.simulateError();
      } catch {
        // Error already logged inside simulateError
      }

      // Example 4: Call API endpoint with proper tracing context propagation
      try {
        this.logger.info('📡 Making API call to /calculate endpoint');

        // Get trace headers to propagate current trace context
        const traceHeaders = traceroot.getTraceHeaders();

        // Get detailed span information for debugging
        const spanInfo = traceroot.getActiveSpanInfo();

        let message = `
        spanInfo: ${JSON.stringify(spanInfo)}
        traceHeaders: ${JSON.stringify(traceHeaders)}
        headerCount: ${Object.keys(traceHeaders).length}
        `;

        this.logger.debug('🔗 Trace Context Debug: ' + message);

        const response = await fetch('http://localhost:9999/calculate', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...traceHeaders,
          },
          body: JSON.stringify([1, 2, 3, 4, 5]),
        });
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        const result = await response.json();

        const spanInfo2 = traceroot.getActiveSpanInfo();
        let message2 = `
        spanInfo2: ${JSON.stringify(spanInfo2)}
        traceHeaders2: ${JSON.stringify(traceHeaders)}
        headerCount2: ${Object.keys(traceHeaders).length}
        `;

        this.logger.debug('🔗 Trace Context Debug: ' + message2);

        this.logger.info('✅ API call completed: ' + result);
      } catch (error: any) {
        this.logger.error('❌ API call failed: ' + error.message);
      }
    } catch (error: any) {
      this.logger.error('❌ Example failed: ' + error.message);
    }
  }
}

async function main() {
  // TraceRoot auto-initializes when the module is imported (if config file exists)
  const example = new TraceRootExample();
  await example.runExample();
}

main()
  .then(async () => {
    await traceroot.forceFlushTracer();
    await traceroot.shutdownTracer();
    await traceroot.forceFlushLogger();
    await traceroot.shutdownLogger();
    process.exit(0);
  })
  .catch(async error => {
    console.error('❌ Example failed:', error);
    process.exit(1);
  });
