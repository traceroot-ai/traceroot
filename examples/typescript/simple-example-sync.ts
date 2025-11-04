import * as traceroot from '../src/index';
import { forceFlushTracerSync, shutdownTracerSync } from '../src/tracer';
import { forceFlushLoggerSync, shutdownLoggerSync } from '../src/logger';

const greet = traceroot.traceFunction(
  function greet(name: string): string {
    const logger = traceroot.getLogger();
    logger.info(`Greeting inside traced function: ${name}`);
    return `Hello, ${name}!`;
  },
  { spanName: 'greet' }
);

greet('world');

// Shutdown the tracer and logger
forceFlushTracerSync();
forceFlushLoggerSync();
shutdownTracerSync();
shutdownLoggerSync();
