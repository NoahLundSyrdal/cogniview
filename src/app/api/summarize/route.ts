import { completeText } from '@/lib/llm';
import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
  try {
    const { insights, actionItems, transcriptSegments, duration } = await req.json();

    if (!insights?.length && !transcriptSegments?.length) {
      return NextResponse.json({ error: 'No meeting data to summarize' }, { status: 400 });
    }

    const insightText = insights
      .map(
        (i: { timestamp: number; screenType: string; summary: string; keyPoints: string[] }) =>
          `[${new Date(i.timestamp).toLocaleTimeString()}] (${i.screenType}) ${i.summary}\n  - ${(i.keyPoints || []).join('\n  - ')}`
      )
      .join('\n\n');

    const transcriptText = (transcriptSegments || [])
      .map(
        (segment: { timestamp: number; text: string }) =>
          `[${new Date(segment.timestamp).toLocaleTimeString()}] ${segment.text}`
      )
      .join('\n');

    const userPrompt = `You are summarizing a meeting that lasted ${duration || 'unknown'} minutes. Here is a timeline of what was shown on screen:

${insightText}

Transcript snippets from the meeting audio:
${transcriptText || 'No transcript captured.'}

Action items identified:
${(actionItems || []).map((item: string, i: number) => `${i + 1}. ${item}`).join('\n')}

Write a concise meeting summary with:
1. **Overview** (2-3 sentences)
2. **Key Topics Covered** (bullet list)
3. **Action Items** (numbered list)
4. **Follow-up Questions** (bullet list of things that may need clarification)

Keep it professional and scannable.`;

    const text = await completeText({ user: userPrompt, maxTokens: 1024 });
    return NextResponse.json({ summary: text });
  } catch (err) {
    console.error('summarize error:', err);
    const message = err instanceof Error ? err.message : 'Summarization failed';
    const isConfig = /API key|LLM configured|required for/i.test(message);
    return NextResponse.json(
      { error: isConfig ? message : 'Summarization failed' },
      { status: 500 }
    );
  }
}
