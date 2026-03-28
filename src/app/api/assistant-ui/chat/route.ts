import { anthropic } from '@ai-sdk/anthropic';
import { openai } from '@ai-sdk/openai';
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  streamText,
  type UIMessage,
} from 'ai';
import { NextRequest } from 'next/server';
import {
  buildSystemPrompt,
  normalizeScreenAnalysis,
  type CopilotChatHistoryMessage,
} from '@/lib/meeting-copilot';
import { resolveProvider } from '@/lib/llm';
import { callRailtracksAgent } from '@/lib/railtracks';

export const runtime = 'nodejs';

type AssistantChatMode = 'v1' | 'v2';

type AssistantUiChatRequest = {
  messages?: UIMessage[];
  mode?: AssistantChatMode;
  meetingContext?: string;
  screenAnalysis?: unknown;
  transcriptContext?: string;
};

function getMessageText(message: UIMessage): string {
  return message.parts
    .filter((part): part is Extract<UIMessage['parts'][number], { type: 'text' }> => part.type === 'text')
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function stripMessageId(message: UIMessage): Omit<UIMessage, 'id'> {
  const { id, ...rest } = message;
  void id;
  return rest;
}

function toChatHistory(messages: UIMessage[]): CopilotChatHistoryMessage[] {
  return messages
    .map((message) => ({
      role: message.role,
      content: getMessageText(message),
    }))
    .filter(
      (message): message is CopilotChatHistoryMessage =>
        (message.role === 'user' || message.role === 'assistant') && message.content.length > 0
    );
}

function chunkText(text: string): string[] {
  const chunks = text.match(/\S+\s*|\n+/g);
  return chunks && chunks.length > 0 ? chunks : [text];
}

function resolveStreamingModel() {
  const provider = resolveProvider();

  if (provider === 'anthropic') {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY is required for Anthropic');
    }

    return anthropic(process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6');
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is required for OpenAI');
  }

  return openai(process.env.OPENAI_MODEL || 'gpt-4o');
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as AssistantUiChatRequest;
    const messages = Array.isArray(body.messages) ? body.messages : [];

    if (messages.length === 0) {
      return new Response('No messages provided', { status: 400 });
    }

    const mode: AssistantChatMode = body.mode === 'v1' ? 'v1' : 'v2';
    const screenAnalysis = normalizeScreenAnalysis(body.screenAnalysis);

    if (mode === 'v1') {
      const modelMessages = await convertToModelMessages(messages.map(stripMessageId));

      const result = streamText({
        model: resolveStreamingModel(),
        system: buildSystemPrompt({
          meetingContext: body.meetingContext,
          screenAnalysis,
          transcriptContext: body.transcriptContext,
          chatHistoryText: null,
        }),
        messages: modelMessages,
      });

      return result.toUIMessageStreamResponse({
        originalMessages: messages,
        onError: () => 'Assistant UI direct chat failed.',
      });
    }

    const lastUserMessage = [...messages].reverse().find((message) => message.role === 'user');
    const latestUserText = lastUserMessage ? getMessageText(lastUserMessage) : '';

    if (!latestUserText) {
      return new Response('No user message provided', { status: 400 });
    }

    const priorMessages =
      lastUserMessage && messages[messages.length - 1]?.id === lastUserMessage.id
        ? messages.slice(0, -1)
        : messages;

    const responseText = await callRailtracksAgent({
      message: latestUserText,
      meetingContext: body.meetingContext,
      screenAnalysis,
      transcriptContext: body.transcriptContext,
      chatHistory: toChatHistory(priorMessages),
    });

    const stream = createUIMessageStream({
      originalMessages: messages,
      execute({ writer }) {
        writer.write({ type: 'start' });
        writer.write({ type: 'start-step' });
        writer.write({ type: 'text-start', id: 'text-1' });
        for (const chunk of chunkText(responseText || 'I was not able to generate a response.')) {
          writer.write({ type: 'text-delta', id: 'text-1', delta: chunk });
        }
        writer.write({ type: 'text-end', id: 'text-1' });
        writer.write({ type: 'finish-step' });
        writer.write({ type: 'finish', finishReason: 'stop' });
      },
      onError: () => 'Assistant UI Railtracks chat failed.',
    });

    return createUIMessageStreamResponse({ stream });
  } catch (error) {
    console.error('assistant-ui chat error:', error);
    const message = error instanceof Error ? error.message : 'Assistant UI chat failed';
    return new Response(message, { status: 500 });
  }
}
