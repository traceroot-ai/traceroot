/**
 * OpenAI Image Agent — TraceRoot Observability
 *
 * A two-step multi-modal flow that tests how the platform tracks images as both
 * output AND input:
 *   step 1: text prompt              → image 1 (output)
 *   step 2: image 1 + edit instruction → image 2 (output)
 * In step 2 the generated image 1 is fed back in as an `input_image`, so the trace
 * carries an image on the input side too.
 *
 * Uses the Responses API with the built-in `image_generation` tool. TraceRoot's
 * instrumentModules auto-instruments the OpenAI call, and observe() adds an
 * explicit span hierarchy.
 *
 * Env vars required: OPENAI_API_KEY, TRACEROOT_API_KEY
 *
 * Run:
 *   pnpm demo:images
 */

import 'dotenv/config';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import OpenAI from 'openai';
import { TraceRoot, observe, usingAttributes } from '@traceroot-ai/traceroot';

// ── TraceRoot setup ───────────────────────────────────────────────────────────
TraceRoot.initialize({
  instrumentModules: { openAI: OpenAI },
});

const openai = new OpenAI();
console.log('[Observability: TraceRoot]');

const MODEL = 'gpt-4.1';
const OUTPUT_DIR = join(process.cwd(), 'generated-images');

// ── Agent ─────────────────────────────────────────────────────────────────────
// Generates an image from a text instruction, optionally conditioned on a prior
// image (passed as an input_image data URI). Returns the new image as a data URI
// so it can be fed back in as the input to a subsequent step.
async function generateImage(
  instruction: string,
  index: number,
  inputImageDataUri?: string,
): Promise<string> {
  return observe({ name: 'generate_image', type: 'tool' }, async () => {
    const content: OpenAI.Responses.ResponseInputContent[] = [
      { type: 'input_text', text: instruction },
    ];
    if (inputImageDataUri) {
      content.push({ type: 'input_image', image_url: inputImageDataUri, detail: 'auto' });
    }

    const response = await openai.responses.create({
      model: MODEL,
      input: [{ role: 'user', content }],
      tools: [{ type: 'image_generation' }],
    });

    // The generated image comes back as raw base64 in the image_generation_call
    // output item.
    const b64 = response.output
      ?.filter((o) => o.type === 'image_generation_call')
      .map((o) => (o as { result: string | null }).result)[0];
    if (!b64) throw new Error('No image data returned');

    await mkdir(OUTPUT_DIR, { recursive: true });
    const filePath = join(OUTPUT_DIR, `image-${index + 1}.png`);
    await writeFile(filePath, Buffer.from(b64, 'base64'));
    console.log(`  [Saved: ${filePath}]`);

    return `data:image/png;base64,${b64}`;
  });
}

// ── Demo ──────────────────────────────────────────────────────────────────────
const BASE_PROMPT = 'A cute cartoon robot waving hello, simple line art on white background.';
const EDIT_INSTRUCTION = 'Add a colorful party hat and some balloons to this robot.';

async function main() {
  try {
    await usingAttributes(
      {
        sessionId: 'openai-image-session',
        userId: 'demo-user',
        tags: ['demo', 'openai', 'image-gen'],
        metadata: { example: 'openai-image-agent', sdkFeature: 'usingAttributes' },
      },
      () => observe({ name: 'image_demo_session' }, async () => {
        console.log('='.repeat(60));
        console.log('OpenAI Image Agent — Demo (TraceRoot)');
        console.log('='.repeat(60));

        // Step 1: text → image 1
        console.log(`\n${'='.repeat(60)}`);
        console.log(`Step 1 (text → image): ${BASE_PROMPT}`);
        console.log('='.repeat(60));
        const image1 = await generateImage(BASE_PROMPT, 0);

        // Step 2: image 1 (as input) + instruction → image 2
        console.log(`\n${'='.repeat(60)}`);
        console.log(`Step 2 (image → image): ${EDIT_INSTRUCTION}`);
        console.log('='.repeat(60));
        await generateImage(EDIT_INSTRUCTION, 1, image1);
      }),
    );
  } finally {
    await TraceRoot.shutdown();
    console.log('[Traces exported]');
  }
}

main().catch(console.error);
