import { completeText } from '@/lib/llm';
import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
  try {
    const { message, meetingContext, screenAnalysis, transcriptContext } = await req.json();

    if (!message) {
      return NextResponse.json({ error: 'No message provided' }, { status: 400 });
    }

    const screenContext = screenAnalysis
      ? `Current screen: ${screenAnalysis.screenType} — ${screenAnalysis.summary}
Key points: ${(screenAnalysis.keyPoints || []).join(', ')}
Action items identified: ${(screenAnalysis.actionItems || []).join(', ')}`
      : 'No screen capture active yet.';

    const systemPrompt = `You are an intelligent meeting copilot. You are watching the user's screen in real-time during their meeting.

${screenContext}

Meeting history so far:
${meetingContext || 'Meeting just started.'}

Recent spoken transcript:
${transcriptContext || 'No transcript available yet.'}

Your role:
- Answer questions about what's being presented on screen
- Suggest questions the user could ask the presenter
- Highlight important points or action items
- Provide relevant context, facts, or definitions
- Be concise and actionable — this is a live meeting, brevity matters
- If asked about something not visible, say so honestly

Respond in 1-3 sentences unless a detailed explanation is genuinely needed.`;

    const text = await completeText({
      system: systemPrompt,
      user: message,
      maxTokens: 512,
    });
    return NextResponse.json({ response: text });
  } catch (err) {
    console.error('chat error:', err);
    const message = err instanceof Error ? err.message : 'Chat failed';
    const isConfig = /API key|LLM configured|required for/i.test(message);
    return NextResponse.json({ error: isConfig ? message : 'Chat failed' }, { status: 500 });
  }
}
