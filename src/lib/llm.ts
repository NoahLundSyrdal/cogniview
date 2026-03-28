import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type { Uploadable } from 'openai/uploads';
import type { FactCheckResult, FactCheckSource, FactCheckVerdict } from '@/types';

export type Provider = 'anthropic' | 'openai';

export function resolveProvider(): Provider {
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

function parseFirstJsonObject(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) return trimmed;
  const match = trimmed.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  return match?.[0] ?? null;
}

function readOutputText(response: unknown): string {
  if (!response || typeof response !== 'object') return '';
  const candidate = response as {
    output_text?: unknown;
    output?: Array<{ content?: Array<{ text?: string; type?: string }> }>;
  };
  if (typeof candidate.output_text === 'string') {
    return candidate.output_text.trim();
  }
  const segments =
    candidate.output
      ?.flatMap((item) => item.content ?? [])
      .filter((part) => part.type === 'output_text' && typeof part.text === 'string')
      .map((part) => part.text as string) ?? [];
  return segments.join('\n').trim();
}

function normalizeSources(sources: unknown): FactCheckSource[] {
  if (!Array.isArray(sources)) return [];
  return sources
    .map((source) => {
      if (!source || typeof source !== 'object') return null;
      const s = source as { title?: unknown; url?: unknown; snippet?: unknown };
      if (typeof s.url !== 'string' || !s.url) return null;
      return {
        title: typeof s.title === 'string' ? s.title : 'Source',
        url: s.url,
        snippet: typeof s.snippet === 'string' ? s.snippet : '',
      };
    })
    .filter((source): source is FactCheckSource => Boolean(source));
}

function normalizeVerdict(verdict: unknown): FactCheckVerdict {
  const value = typeof verdict === 'string' ? verdict.trim().toLowerCase() : '';
  if (
    value === 'supported' ||
    value === 'contradicted' ||
    value === 'mixed' ||
    value === 'insufficient_evidence'
  ) {
    return value;
  }
  return 'insufficient_evidence';
}

async function createOpenAIResponseWithWebSearch(
  openai: OpenAI,
  request: Record<string, unknown>
): Promise<unknown> {
  const toolVariants = ['web_search_preview', 'web_search'];
  let lastError: unknown = null;
  for (const toolType of toolVariants) {
    try {
      return await openai.responses.create({
        ...request,
        tools: [{ type: toolType }],
      } as never);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Web search request failed');
}

export async function extractClaimsFromImage(params: {
  base64: string;
  mimeType: string;
  meetingContext?: string;
  maxClaims?: number;
}): Promise<string[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is required for fact-checking');
  }
  const model = process.env.OPENAI_FACTCHECK_IMAGE_MODEL || 'gpt-5.4';
  const maxClaims = params.maxClaims ?? Number(process.env.FACTCHECK_MAX_CLAIMS || 5);
  const openai = new OpenAI({ apiKey });
  const mime = params.mimeType.startsWith('image/') ? params.mimeType : 'image/jpeg';
  const dataUrl = `data:${mime};base64,${params.base64}`;
  const contextLine = params.meetingContext?.trim()
    ? `Meeting context:\n${params.meetingContext.trim()}\n`
    : 'Meeting context is unavailable.\n';

  const response = await openai.responses.create({
    model,
    input: [
      {
        role: 'system',
        content: [
          {
            type: 'input_text',
            text: `You extract factual claims from screenshots.
- Keep only claims that are both checkable and high-value to verify.
- Prioritize claims that are likely wrong, surprising, high-impact, or contentious.
- Prioritize claims with specific numbers, percentages, dates, rankings, causal assertions, or strong superlatives.
- Ignore obvious/common-knowledge claims that are very likely correct without verification.
- Ignore generic statements, definitions, product slogans, and procedural instructions.
- If nothing meaningfully needs fact-checking, return an empty list.
- Rank by fact-check priority and keep only the top claims.
- Deduplicate semantically similar claims.
- Return JSON only in this shape: {"claims":["..."]}.
- Keep each claim under 180 characters.
- Return at most ${maxClaims} claims.`,
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: `${contextLine}
Analyze the screenshot and extract only the most important claims that actually need fact-checking.
Do not include obvious claims.`,
          },
          { type: 'input_image', image_url: dataUrl },
        ],
      },
    ],
    max_output_tokens: 700,
  } as never);

  const raw = readOutputText(response);
  const jsonBlob = parseFirstJsonObject(raw);
  if (!jsonBlob) return [];
  try {
    const parsed = JSON.parse(jsonBlob) as { claims?: unknown };
    if (!Array.isArray(parsed.claims)) return [];
    const seen = new Set<string>();
    const claims: string[] = [];
    for (const claim of parsed.claims) {
      if (typeof claim !== 'string') continue;
      const clean = claim.trim();
      if (!clean) continue;
      const key = clean.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      claims.push(clean);
      if (claims.length >= maxClaims) break;
    }
    return claims;
  } catch {
    return [];
  }
}

export async function verifyClaimWithWebSearch(params: {
  claim: string;
  meetingContext?: string;
}): Promise<FactCheckResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is required for fact-checking');
  }
  const model = process.env.OPENAI_FACTCHECK_REASONING_MODEL || 'gpt-5.4';
  const openai = new OpenAI({ apiKey });
  const contextLine = params.meetingContext?.trim()
    ? `Context from meeting:\n${params.meetingContext.trim()}\n`
    : 'No additional meeting context provided.\n';

  const response = await createOpenAIResponseWithWebSearch(openai, {
    model,
    input: [
      {
        role: 'system',
        content: [
          {
            type: 'input_text',
            text: `You are a strict fact-checking assistant.
- Use web sources to evaluate the claim.
- Prefer primary or reputable sources.
- If evidence conflicts or is weak, choose mixed/insufficient_evidence.
- Return JSON only in this exact shape:
{
  "verdict":"supported|contradicted|mixed|insufficient_evidence",
  "confidence":0.0,
  "summary":"1-2 sentences.",
  "sources":[{"title":"...","url":"https://...","snippet":"..."}]
}`,
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: `${contextLine}
Fact-check this claim:\n"${params.claim}"`,
          },
        ],
      },
    ],
    max_output_tokens: 900,
  });

  const raw = readOutputText(response);
  const jsonBlob = parseFirstJsonObject(raw);
  if (!jsonBlob) {
    return {
      claim: params.claim,
      verdict: 'insufficient_evidence',
      confidence: 0.2,
      summary: 'No structured fact-check result was returned.',
      sources: [],
    };
  }

  try {
    const parsed = JSON.parse(jsonBlob) as {
      verdict?: unknown;
      confidence?: unknown;
      summary?: unknown;
      sources?: unknown;
    };
    const confidenceValue =
      typeof parsed.confidence === 'number'
        ? Math.max(0, Math.min(1, parsed.confidence))
        : 0.5;
    return {
      claim: params.claim,
      verdict: normalizeVerdict(parsed.verdict),
      confidence: confidenceValue,
      summary:
        typeof parsed.summary === 'string' && parsed.summary.trim()
          ? parsed.summary.trim()
          : 'The available evidence is inconclusive.',
      sources: normalizeSources(parsed.sources),
    };
  } catch {
    return {
      claim: params.claim,
      verdict: 'insufficient_evidence',
      confidence: 0.2,
      summary: 'Could not parse fact-check output from the model.',
      sources: [],
    };
  }
}

export async function verifyClaimsWithWebSearch(params: {
  claims: string[];
  meetingContext?: string;
}): Promise<FactCheckResult[]> {
  const claims = params.claims.filter((claim) => claim.trim().length > 0);
  const results: FactCheckResult[] = [];
  for (const claim of claims) {
    // Keep sequential calls to avoid tool overuse/rate bursts.
    const result = await verifyClaimWithWebSearch({
      claim,
      meetingContext: params.meetingContext,
    });
    results.push(result);
  }
  return results;
}
