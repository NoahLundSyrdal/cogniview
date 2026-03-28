import { completeText } from '@/lib/llm';
import { NextRequest, NextResponse } from 'next/server';

type ScreenAnalysisPayload = {
  screenType?: string;
  summary?: string;
  keyPoints?: string[];
  actionItems?: string[];
};

type ChatRequestPayload = {
  message?: string;
  meetingContext?: string;
  screenAnalysis?: ScreenAnalysisPayload | null;
  transcriptContext?: string;
};

type RailtracksResponsePayload = {
  response?: unknown;
  error?: unknown;
};

function normalizeStringArray(values: unknown): string[] {
  if (!Array.isArray(values)) {
    return [];
  }

  return values
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim());
}

function normalizeScreenAnalysis(value: unknown): ScreenAnalysisPayload | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const screenType =
    typeof candidate.screenType === 'string' && candidate.screenType.trim().length > 0
      ? candidate.screenType
      : undefined;
  const summary =
    typeof candidate.summary === 'string' && candidate.summary.trim().length > 0
      ? candidate.summary
      : undefined;
  const keyPoints = normalizeStringArray(candidate.keyPoints);
  const actionItems = normalizeStringArray(candidate.actionItems);

  if (!screenType && !summary && keyPoints.length === 0 && actionItems.length === 0) {
    return null;
  }

  return {
    ...(screenType ? { screenType } : {}),
    ...(summary ? { summary } : {}),
    keyPoints,
    actionItems,
  };
}

function buildScreenContext(screenAnalysis: ScreenAnalysisPayload | null): string {
  if (!screenAnalysis) {
    return 'No screen capture active yet.';
  }

  const screenType = screenAnalysis.screenType || 'Unknown screen';
  const summary = screenAnalysis.summary || 'No screen summary available.';
  const keyPoints = screenAnalysis.keyPoints?.join(', ') || 'None';
  const actionItems = screenAnalysis.actionItems?.join(', ') || 'None';

  return `Current screen: ${screenType} - ${summary}
Key points: ${keyPoints}
Action items identified: ${actionItems}`;
}

function buildSystemPrompt(params: {
  meetingContext?: string;
  screenAnalysis: ScreenAnalysisPayload | null;
  transcriptContext?: string;
}): string {
  return `You are an intelligent meeting copilot. You are watching the user's screen in real-time during their meeting.

${buildScreenContext(params.screenAnalysis)}

Meeting history so far:
${params.meetingContext || 'Meeting just started.'}

Recent spoken transcript:
${params.transcriptContext || 'No transcript available yet.'}

Your role:
- Answer questions about what's being presented on screen
- Suggest questions the user could ask the presenter
- Highlight important points or action items
- Provide relevant context, facts, or definitions
- Be concise and actionable - this is a live meeting, brevity matters
- If asked about something not visible, say so honestly

Respond in 1-3 sentences unless a detailed explanation is genuinely needed.`;
}

async function callRailtracksAgent(payload: {
  message: string;
  meetingContext?: string;
  screenAnalysis: ScreenAnalysisPayload | null;
  transcriptContext?: string;
}): Promise<string> {
  const baseUrl = process.env.RAILTRACKS_AGENT_URL?.trim();
  if (!baseUrl) {
    throw new Error('RAILTRACKS_AGENT_URL is not set');
  }

  const endpoint = `${baseUrl.replace(/\/$/, '')}/chat`;
  let response: Response;

  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      cache: 'no-store',
      body: JSON.stringify(payload),
    });
  } catch {
    throw new Error(`Railtracks agent is unavailable at ${endpoint}`);
  }

  const rawBody = await response.text();
  let data: RailtracksResponsePayload | null = null;

  if (rawBody) {
    try {
      data = JSON.parse(rawBody) as RailtracksResponsePayload;
    } catch {
      data = null;
    }
  }

  if (!response.ok) {
    const message =
      typeof data?.error === 'string'
        ? data.error
        : `Railtracks agent request failed with status ${response.status}`;
    throw new Error(message);
  }

  if (typeof data?.response !== 'string') {
    throw new Error('Railtracks agent returned an invalid response');
  }

  return data.response.trim();
}

export async function POST(req: NextRequest) {
  try {
    const { message, meetingContext, screenAnalysis, transcriptContext } =
      (await req.json()) as ChatRequestPayload;

    if (!message?.trim()) {
      return NextResponse.json({ error: 'No message provided' }, { status: 400 });
    }

    const normalizedScreenAnalysis = normalizeScreenAnalysis(screenAnalysis);
    const normalizedPayload = {
      message: message.trim(),
      ...(typeof meetingContext === 'string' ? { meetingContext } : {}),
      screenAnalysis: normalizedScreenAnalysis,
      ...(typeof transcriptContext === 'string' ? { transcriptContext } : {}),
    };

    if (process.env.RAILTRACKS_AGENT_URL?.trim()) {
      const railtracksResponse = await callRailtracksAgent(normalizedPayload);
      return NextResponse.json({ response: railtracksResponse });
    }

    const text = await completeText({
      system: buildSystemPrompt({
        meetingContext: normalizedPayload.meetingContext,
        screenAnalysis: normalizedPayload.screenAnalysis,
        transcriptContext: normalizedPayload.transcriptContext,
      }),
      user: normalizedPayload.message,
      maxTokens: 512,
    });
    return NextResponse.json({ response: text });
  } catch (err) {
    console.error('chat error:', err);
    const message = err instanceof Error ? err.message : 'Chat failed';
    const isConfig = /API key|LLM configured|required for/i.test(message);
    const isRailtracks = /Railtracks/i.test(message);
    return NextResponse.json(
      { error: isConfig || isRailtracks ? message : 'Chat failed' },
      { status: 500 }
    );
  }
}
