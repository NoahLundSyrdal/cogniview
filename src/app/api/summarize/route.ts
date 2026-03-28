import Anthropic from '@anthropic-ai/sdk';
import { NextRequest, NextResponse } from 'next/server';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function POST(req: NextRequest) {
  try {
    const { insights, actionItems, duration } = await req.json();

    if (!insights?.length) {
      return NextResponse.json({ error: 'No insights to summarize' }, { status: 400 });
    }

    const insightText = insights
      .map(
        (i: { timestamp: number; screenType: string; summary: string; keyPoints: string[] }, idx: number) =>
          `[${new Date(i.timestamp).toLocaleTimeString()}] (${i.screenType}) ${i.summary}\n  - ${(i.keyPoints || []).join('\n  - ')}`
      )
      .join('\n\n');

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: `You are summarizing a meeting that lasted ${duration || 'unknown'} minutes. Here is a timeline of what was shown on screen:

${insightText}

Action items identified:
${(actionItems || []).map((item: string, i: number) => `${i + 1}. ${item}`).join('\n')}

Write a concise meeting summary with:
1. **Overview** (2-3 sentences)
2. **Key Topics Covered** (bullet list)
3. **Action Items** (numbered list)
4. **Follow-up Questions** (bullet list of things that may need clarification)

Keep it professional and scannable.`,
        },
      ],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    return NextResponse.json({ summary: text });
  } catch (err) {
    console.error('summarize error:', err);
    return NextResponse.json({ error: 'Summarization failed' }, { status: 500 });
  }
}
