/**
 * OpenAI Voice Agent — TraceRoot Observability
 *
 * A two-step flow that tests how the platform tracks audio as both output AND
 * input:
 *   step 1: text          → speech (audio output)
 *   step 2: speech (audio) → transcribed text (audio input)
 * The generated audio from step 1 is fed back into step 2 as the input, so the
 * trace carries voice on both the output and input sides.
 *
 * Uses the gpt-4o-audio chat API: it returns audio as base64 inside the response
 * (message.audio.data) and accepts an input_audio content part — so the audio
 * rides the auto-instrumented OpenAI call as STRUCTURED content (the same shape
 * images took). Each step is also wrapped in observe() as a tool span, whose
 * input/output is a bare audio data URI — covering the non-instrumented
 * (bare-string) path too, so one example exercises both render paths.
 *
 * Env vars required: OPENAI_API_KEY, TRACEROOT_API_KEY
 *
 * Run:
 *   pnpm demo:voice
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

const MODEL = 'gpt-audio-mini';
const VOICE = 'alloy';
const FORMAT = 'wav';
const OUTPUT_DIR = join(process.cwd(), 'generated-audio');

// ── Agent ─────────────────────────────────────────────────────────────────────
// text → speech. Returns the audio as a data URI so it can be fed back in as the
// input to the transcription step (and rendered inline in the trace viewer).
async function textToSpeech(text: string): Promise<string> {
  const completion = await openai.chat.completions.create({
    model: MODEL,
    modalities: ['text', 'audio'],
    audio: { voice: VOICE, format: FORMAT },
    messages: [{ role: 'user', content: text }],
  });

  const data = completion.choices[0].message.audio?.data;
  if (!data) throw new Error('No audio returned');

  await mkdir(OUTPUT_DIR, { recursive: true });
  const filePath = join(OUTPUT_DIR, 'speech.wav');
  await writeFile(filePath, Buffer.from(data, 'base64'));
  console.log(`  [Saved: ${filePath}]`);

  return `data:audio/wav;base64,${data}`;
}

// speech (audio data URI) → transcribed text.
async function speechToText(audioDataUri: string): Promise<string> {
  const base64 = audioDataUri.slice(audioDataUri.indexOf(',') + 1);
  const completion = await openai.chat.completions.create({
    model: MODEL,
    modalities: ['text'],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Transcribe this audio exactly, returning only the spoken words.' },
          { type: 'input_audio', input_audio: { data: base64, format: FORMAT } },
        ],
      },
    ],
  });

  return completion.choices[0].message.content ?? '';
}

// ── Demo ──────────────────────────────────────────────────────────────────────
const PROMPT = 'Hello from TraceRoot! This message was spoken by an AI voice, then transcribed back to text.';

async function main() {
  try {
    await usingAttributes(
      {
        sessionId: 'openai-voice-session',
        userId: 'demo-user',
        tags: ['demo', 'openai', 'voice'],
        metadata: { example: 'openai-voice-agent', sdkFeature: 'usingAttributes' },
      },
      () => observe({ name: 'voice_demo_session' }, async () => {
        console.log('='.repeat(60));
        console.log('OpenAI Voice Agent — Demo (TraceRoot)');
        console.log('='.repeat(60));

        // Step 1: text → speech
        console.log(`\n${'='.repeat(60)}`);
        console.log(`Step 1 (text → speech): ${PROMPT}`);
        console.log('='.repeat(60));
        const audio = await observe({ name: 'text_to_speech', type: 'tool' }, textToSpeech, PROMPT);

        // Step 2: speech (as input) → transcribed text
        console.log(`\n${'='.repeat(60)}`);
        console.log('Step 2 (speech → text): transcribing generated audio');
        console.log('='.repeat(60));
        const transcript = await observe(
          { name: 'speech_to_text', type: 'tool' },
          speechToText,
          audio,
        );
        console.log(`  [Transcript: ${transcript}]`);
      }),
    );
  } finally {
    await TraceRoot.shutdown();
    console.log('[Traces exported]');
  }
}

main().catch(console.error);
