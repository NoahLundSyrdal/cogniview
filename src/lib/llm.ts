import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type { Uploadable } from 'openai/uploads';

type Provider = 'anthropic' | 'openai';

function resolveProvider(): Provider {
  const explicit = process.env.LLM_PROVIDER?.toLowerCase().trim();
  if (explicit === 'openai' || explicit === 'anthropic') {
    return explicit;
  }
  const hasAnthropic = Boolean(process.env.ANTHROPIC_API_KEY);
  const hasOpenai = Boolean(process.env.OPENAI_API_KEY);
  if (hasAnthropic && !hasOpenai) return 'anthropic';
  if (hasOpenai && !hasAnthropic) return 'openai';
  if (hasAnthropic && hasOpenai) return 'anthropic';
  throw new Error(
    'No LLM configured: set ANTHROPIC_API_KEY and/or OPENAI_API_KEY (optionally LLM_PROVIDER=anthropic|openai when both are set).'
  );
}

export async function completeText(params: {
  system?: string;
  user: string;
  maxTokens: number;
}): Promise<string> {
  const provider = resolveProvider();

  if (provider === 'anthropic') {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY is required for Anthropic');
    }
    const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
    const anthropic = new Anthropic({ apiKey });
    const response = await anthropic.messages.create({
      model,
      max_tokens: params.maxTokens,
      ...(params.system ? { system: params.system } : {}),
      messages: [{ role: 'user', content: params.user }],
    });
    const block = response.content[0];
    return block.type === 'text' ? block.text : '';
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is required for OpenAI');
  }
  const model = process.env.OPENAI_MODEL || 'gpt-4o';
  const openai = new OpenAI({ apiKey });
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  if (params.system) {
    messages.push({ role: 'system', content: params.system });
  }
  messages.push({ role: 'user', content: params.user });
  const response = await openai.chat.completions.create({
    model,
    max_tokens: params.maxTokens,
    messages,
  });
  const text = response.choices[0]?.message?.content;
  return typeof text === 'string' ? text.trim() : '';
}

const anthropicImageMediaTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;
type AnthropicImageMediaType = (typeof anthropicImageMediaTypes)[number];

function toAnthropicImageMediaType(mime: string): AnthropicImageMediaType {
  const m = mime.toLowerCase();
  if (anthropicImageMediaTypes.includes(m as AnthropicImageMediaType)) {
    return m as AnthropicImageMediaType;
  }
  return 'image/jpeg';
}

/** Screen/frame analysis with the same provider selection as `completeText` (LLM_PROVIDER, keys). */
export async function completeVision(params: {
  prompt: string;
  base64: string;
  mimeType: string;
  maxTokens: number;
}): Promise<string> {
  const provider = resolveProvider();
  const mime = params.mimeType.startsWith('image/') ? params.mimeType : 'image/jpeg';

  if (provider === 'anthropic') {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY is required for Anthropic');
    }
    const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
    const anthropic = new Anthropic({ apiKey });
    const response = await anthropic.messages.create({
      model,
      max_tokens: params.maxTokens,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: params.prompt },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: toAnthropicImageMediaType(mime),
                data: params.base64,
              },
            },
          ],
        },
      ],
    });
    const block = response.content[0];
    return block.type === 'text' ? block.text : '';
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is required for OpenAI');
  }
  const model = process.env.OPENAI_MODEL || 'gpt-4o';
  const openai = new OpenAI({ apiKey });
  const dataUrl = `data:${mime};base64,${params.base64}`;
  const response = await openai.chat.completions.create({
    model,
    max_tokens: params.maxTokens,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: params.prompt },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
  });
  const text = response.choices[0]?.message?.content;
  return typeof text === 'string' ? text.trim() : '';
}

export async function transcribeAudio(params: {
  file: Uploadable;
  prompt?: string;
}): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is required for transcription with gpt-4o-transcribe.');
  }

  const openai = new OpenAI({ apiKey });
  const model = process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-4o-transcribe';
  const transcription = await openai.audio.transcriptions.create({
    file: params.file,
    model,
    ...(params.prompt ? { prompt: params.prompt } : {}),
  });

  return transcription.text.trim();
}
