import type { TraceRootConfigFile } from 'traceroot-sdk-ts';

const config: TraceRootConfigFile = {
  // Basic service configuration
  service_name: 'ts-example-service',
  github_owner: 'traceroot-ai',
  github_repo_name: 'traceroot',
  github_commit_hash: 'main',

  // Your environment configuration
  // development, staging, production
  environment: 'development',

  // Token configuration
  token: 'your_traceroot_token_here',

  // Whether to enable console export of spans and logs
  enable_span_console_export: false,
  enable_log_console_export: true,

  // Local mode that whether to store all data locally
  local_mode: false,
};

export default config;
