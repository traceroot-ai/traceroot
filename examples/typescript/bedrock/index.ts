import 'dotenv/config';

import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
  type ConverseOutput,
} from '@aws-sdk/client-bedrock-runtime';
import * as bedrockRuntime from '@aws-sdk/client-bedrock-runtime';
import { TraceRoot, observe, usingAttributes } from '@traceroot-ai/traceroot';

TraceRoot.initialize({ instrumentModules: { bedrock: bedrockRuntime } });

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function textFromContentBlocks(blocks: ContentBlock[] | undefined): string {
  if (!blocks?.length) {
    return '';
  }
  const parts: string[] = [];
  for (const block of blocks) {
    if ('text' in block && typeof block.text === 'string' && block.text.length > 0) {
      parts.push(block.text);
    }
  }
  return parts.join('');
}

function assistantTextFromOutput(output: ConverseOutput | undefined): string {
  if (!output || !('message' in output) || !output.message?.content) {
    return '';
  }
  return textFromContentBlocks(output.message.content);
}

async function converse(prompt: string): Promise<string> {
  return observe({ name: 'bedrock_converse', type: 'llm' }, async () => {
    const region = requireEnv('AWS_REGION');
    const modelId = requireEnv('BEDROCK_MODEL_ID');
    const client = new BedrockRuntimeClient({ region });

    const command = new ConverseCommand({
      modelId,
      messages: [
        {
          role: 'user',
          content: [{ text: prompt }],
        },
      ],
    });

    const response = await client.send(command);
    const text = assistantTextFromOutput(response.output);
    if (text === '') {
      throw new Error('Empty model response (check model access and BEDROCK_MODEL_ID).');
    }
    return text;
  });
}

async function main(): Promise<void> {
  try {
    await usingAttributes(
      {
        sessionId: 'bedrock-ts-demo',
        userId: 'demo-user',
        tags: ['demo', 'bedrock'],
        metadata: { example: 'bedrock-converse' },
      },
      async () =>
        observe({ name: 'demo_session' }, async () => {
          const answer = await converse('Say hello in one short sentence.');
          console.log(answer);
        }),
    );
  } finally {
    await TraceRoot.shutdown();
    console.log('[Traces exported]');
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
