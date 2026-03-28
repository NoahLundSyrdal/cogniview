import { completeText } from '@/lib/llm';
import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
  try {
    const { insights, actionItems, transcriptSegments, duration } = await req.json();
    const concreteActionItems = Array.isArray(actionItems)
      ? actionItems
          .filter((item): item is string => typeof item === 'string')
          .map((item) => item.trim())
          .filter(Boolean)
      : [];

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
${concreteActionItems.map((item, i) => `${i + 1}. ${item}`).join('\n') || 'No explicit action items were pre-identified.'}

Write a concise meeting summary with:
1. **Overview** (2-3 sentences)
2. **Key Topics Covered** (bullet list)
3. **Action Items** (numbered list with concrete todos)
4. **Follow-up Questions** (bullet list of things that may need clarification)

Keep it professional and scannable.

Action Items requirements:
- Extract concrete todos from both transcript snippets and screen timeline.
- Prefer owner/deadline details when clearly present.
- If no concrete todos exist, explicitly write \"No concrete todos identified.\"`;

    const text = await completeText({ user: userPrompt, maxTokens: 1024 });
    const concreteTodoAppendix = concreteActionItems.length
      ? `\n\n## Concrete Todos (verbatim)\n${concreteActionItems
          .map((item, i) => `${i + 1}. ${item}`)
          .join('\n')}`
      : '';

    return NextResponse.json({ summary: `${text}${concreteTodoAppendix}` });
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
