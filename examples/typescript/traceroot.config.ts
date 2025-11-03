import type { TraceRootConfigFile } from 'traceroot-sdk-ts';

const config: TraceRootConfigFile = {
  // The token for the TraceRoot API
  token: your_traceroot_token_here,

  // The name of the service you are tracing.
  service_name: 'ts-example',

  // The owner of the GitHub repository
  github_owner: 'traceroot-ai',

  // The name of the GitHub repository
  github_repo_name: 'traceroot',

  // The commit hash of the GitHub repository
  github_commit_hash: 'main',

  // Enable cloud export of spans (default: `true`)
  enable_span_cloud_export: true,

  // Enable cloud export of logs (default: `true`)
  enable_log_cloud_export: true,

  // Enable console export of spans (default: `false`)
  enable_span_console_export: false,

  // Enable console export of logs (default: `true`)
  enable_log_console_export: true,

  // The environment configuration such as development, staging, production
  environment: 'development',

  // Whether to store all telemetry data locally.
  local_mode: false,
};
export default config;
