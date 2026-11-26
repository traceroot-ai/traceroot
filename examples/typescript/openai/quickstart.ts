/**
 * Tracing quickstart: initialize traceroot in the function the entry point calls.
 *
 * The block between the markers is synced into docs/tracing/get-started.mdx by
 * scripts/sync_doc_snippets.py.
 *
 * Run:
 *   pnpm tsx quickstart.ts
 */

import { pathToFileURL } from 'node:url';

// [start:tracing-get-started-typescript]
// import { config } from 'dotenv';  // Uncomment if using a .env file (requires: npm install dotenv)
import OpenAI from 'openai';
import { TraceRoot } from '@traceroot-ai/traceroot';

async function main() {
  // config();
  TraceRoot.initialize({ instrumentModules: { openAI: OpenAI } });  // instruments all OpenAI calls
  const openai = new OpenAI();
  // ...your application
}

// Call main() from your entry point.
// [end:tracing-get-started-typescript]

// Run main() when this file is executed, not when another module imports it.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
