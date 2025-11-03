import * as traceroot from '../src/index';

const main = traceroot.traceFunction(
  async function main() {
    console.log('=== TraceRoot Log Level Example ===\n');

    console.log('--- Test 1: Default Debug Level ---');
    // Initialize with default debug level
    await traceroot.init({
      service_name: 'log-level-test',
      github_owner: 'traceroot-ai',
      github_repo_name: 'traceroot-sdk-ts',
      github_commit_hash: 'abc123',
      environment: 'test',
      local_mode: true,
      enable_log_console_export: true,
      enable_log_cloud_export: false,
      log_level: 'debug', // Explicit debug level
    });

    const defaultLogger = traceroot.getLogger();
    console.log('Default level logger - should only show error and critical:');
    defaultLogger.debug('🔴 DEBUG message - should NOT appear');
    defaultLogger.info('🔴 INFO message - should NOT appear');
    defaultLogger.warn('🔴 WARN message - should NOT appear');
    defaultLogger.error('🟢 ERROR message - should appear');
    defaultLogger.critical('🟢 CRITICAL message - should appear');

    const debugLogger = traceroot.getLogger('debug-logger');
    console.log('\nDebug level logger - should show all levels:');
    debugLogger.debug('🟢 DEBUG message - should appear');
    debugLogger.info('🟢 INFO message - should appear');
    debugLogger.warn('🟢 WARN message - should appear');
    debugLogger.error('🟢 ERROR message - should appear');
    debugLogger.critical('🟢 CRITICAL message - should appear');

    console.log('\n--- Test 2: Warn Level Override ---');
    // Get logger with WARN level override
    const warnLogger = traceroot.getLogger('warn-logger', 'warn');
    console.log('Warn level logger - should only show warn, error, and critical:');
    warnLogger.debug('🔴 DEBUG message - should NOT appear');
    warnLogger.info('🔴 INFO message - should NOT appear');
    warnLogger.warn('🟢 WARN message - should appear');
    warnLogger.error('🟢 ERROR message - should appear');
    warnLogger.critical('🟢 CRITICAL message - should appear');

    console.log('\n--- Test 3: Error Level Override ---');
    // Get logger with ERROR level override
    const errorLogger = traceroot.getLogger('error-logger', 'error');
    console.log('Error level logger - should only show error and critical:');
    errorLogger.debug('🔴 DEBUG message - should NOT appear');
    errorLogger.info('🔴 INFO message - should NOT appear');
    errorLogger.warn('🔴 WARN message - should NOT appear');
    errorLogger.error('🟢 ERROR message - should appear');
    errorLogger.critical('🟢 CRITICAL message - should appear');

    console.log('\n--- Test 4: Child Logger Level Inheritance ---');
    const childLogger = warnLogger.child({ module: 'auth' });
    console.log('Child logger inherits WARN level from parent:');
    childLogger.debug('🔴 Child DEBUG - should NOT appear');
    childLogger.info('🔴 Child INFO - should NOT appear');
    childLogger.warn('🟢 Child WARN - should appear with context');
    childLogger.error('🟢 Child ERROR - should appear with context');

    console.log('\n--- Test 5: Silent Level ---');
    const silentLogger = traceroot.getLogger('silent-logger', 'silent');
    console.log('Silent logger - nothing should appear below:');
    silentLogger.debug('🔴 Silent DEBUG - should NOT appear');
    silentLogger.info('🔴 Silent INFO - should NOT appear');
    silentLogger.warn('🔴 Silent WARN - should NOT appear');
    silentLogger.error('🔴 Silent ERROR - should NOT appear');
    silentLogger.critical('🔴 Silent CRITICAL - should NOT appear');
    console.log('(End of silent test - nothing should have appeared above)');
  },
  { spanName: 'logLevelExample', traceParams: false }
);

main()
  .then(async () => {
    await traceroot.forceFlushTracer();
    await traceroot.forceFlushLogger();
    await traceroot.shutdownLogger();
    await traceroot.shutdownTracer();
    process.exit(0);
  })
  .catch(console.error);
