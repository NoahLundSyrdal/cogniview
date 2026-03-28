import Anthropic from '@anthropic-ai/sdk';
import { NextRequest, NextResponse } from 'next/server';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function POST(req: NextRequest) {
  try {
    const { message, meetingContext, screenAnalysis } = await req.json();

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

Your role:
- Answer questions about what's being presented on screen
- Suggest questions the user could ask the presenter
- Highlight important points or action items
- Provide relevant context, facts, or definitions
- Be concise and actionable — this is a live meeting, brevity matters
- If asked about something not visible, say so honestly

Respond in 1-3 sentences unless a detailed explanation is genuinely needed.`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 512,
      system: systemPrompt,
      messages: [{ role: 'user', content: message }],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    return NextResponse.json({ response: text });
  } catch (err) {
    console.error('chat error:', err);
    return NextResponse.json({ error: 'Chat failed' }, { status: 500 });
  }
}
