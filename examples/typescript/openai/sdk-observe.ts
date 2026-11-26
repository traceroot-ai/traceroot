/**
 * SDK reference example: wrap an async function with observe() to create a span.
 *
 * The block between the markers is synced into docs/tracing/typescript-sdk.mdx by
 * scripts/sync_doc_snippets.py.
 *
 * Run:
 *   pnpm tsx sdk-observe.ts
 */

// [start:typescript-sdk-observe]
import { observe } from '@traceroot-ai/traceroot';

const result = await observe({ name: 'my_function', type: 'tool' }, async () => {
  return 'your result here';
});
// [end:typescript-sdk-observe]

console.log(result);
