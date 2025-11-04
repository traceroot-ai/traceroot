import * as traceroot from '../src/index';

const main = traceroot.traceFunction(
  async function main() {
    // Get the main logger
    const logger = traceroot.getLogger();
    logger.info('Main logger initialized');

    // Create child loggers with different contexts
    const authLogger = logger.child({ module: 'auth' });
    const dbLogger = logger.child({ module: 'database' });
    const apiLogger = logger.child({ module: 'api', version: '1.0' });

    // Use child loggers - context is automatically included
    authLogger.info('User login attempt started');
    authLogger.info({ userId: 'user123' }, 'Login successful');

    dbLogger.info('Connecting to database');
    dbLogger.warn({ table: 'users', query: 'SELECT *' }, 'Slow query detected');

    apiLogger.info({ endpoint: '/users', method: 'GET' }, 'API request processed');

    // Create nested child loggers
    const authLoginLogger = authLogger.child({ operation: 'login' });
    const authRegisterLogger = authLogger.child({ operation: 'register' });

    authLoginLogger.info({ userId: 'user123', sessionId: 'sess456' }, 'Processing login');
    authRegisterLogger.info({ email: 'user@example.com' }, 'New user registration');

    // Even deeper nesting
    const authLoginValidationLogger = authLoginLogger.child({ step: 'validation' });
    authLoginValidationLogger.debug('Validating user credentials');
    authLoginValidationLogger.info({ validationResult: 'success' }, 'Credentials validated');

    // Child context is persistent and not overridable (pino behavior)
    authLogger.info({ attempt: 'second' }, 'This will show both module: auth and attempt: second');

    // Create a new child logger for authLogger with a overridden module name
    const authChildLogger = authLogger.child({ module: 'auth_child', version: '2.0' });
    authChildLogger.info({ userId: 'user456' }, 'Processing login');

    // Multiple objects still work
    apiLogger.info({ requestId: 'req123' }, { userId: 'user456' }, 'Complex API operation');

    // Nested context example (similar to req.logtail pattern)
    const requestLogger = logger.child({
      context: {
        req: {
          id: 'req-789',
          method: 'POST',
          path: '/api/users',
        },
      },
    });
    requestLogger.info({ action: 'validation' }, 'Request validation started');
    requestLogger.info({ userId: 'user789', status: 'success' }, 'Request processed successfully');

    const requestChildLogger = requestLogger.child({
      context: {
        req: {
          id: 'req-123',
          method: 'GET',
          path: '/api/users',
        },
      },
    });
    requestChildLogger.info({ action: 'validation' }, 'Request validation started');

    // Test flush and shutdown with the actual child loggers that were used
    await authLogger.flush();
    await dbLogger.flush();
    await apiLogger.flush();
    await traceroot.forceFlushLogger();
    await traceroot.shutdownLogger();
  },
  { spanName: 'childLoggerExample', traceParams: false }
);

main()
  .then(async () => {
    await traceroot.forceFlushTracer();
    await traceroot.shutdownTracer();
    process.exit(0);
  })
  .catch(console.error);
