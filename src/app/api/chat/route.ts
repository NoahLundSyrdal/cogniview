import { completeText } from '@/lib/llm';
import { NextRequest, NextResponse } from 'next/server';
import { buildSystemPrompt, normalizeScreenAnalysis, type ScreenAnalysisPayload } from '@/lib/meeting-copilot';
import { callRailtracksAgent } from '@/lib/railtracks';

type ChatRequestPayload = {
  message?: string;
  meetingContext?: string;
  screenAnalysis?: ScreenAnalysisPayload | null;
  transcriptContext?: string;
};

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
        chatHistoryText: null,
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
