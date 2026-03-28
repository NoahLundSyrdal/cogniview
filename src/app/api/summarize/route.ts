import { completeText } from '@/lib/llm';
import { callRailtracksSummary } from '@/lib/railtracks';
import { NextRequest, NextResponse } from 'next/server';

function normalizeSummaryKey(text: string) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

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

    const concreteTodoAppendix = concreteActionItems.length
      ? `\n\n## Concrete Todos (verbatim)\n${concreteActionItems
          .map((item, i) => `${i + 1}. ${item}`)
          .join('\n')}`
      : '';

    if (process.env.RAILTRACKS_AGENT_URL?.trim()) {
      const summary = await callRailtracksSummary({
        insights: Array.isArray(insights) ? insights : [],
        actionItems: concreteActionItems,
        transcriptSegments: Array.isArray(transcriptSegments) ? transcriptSegments : [],
        ...(typeof duration === 'number' && Number.isFinite(duration) && duration > 0
          ? { duration: Math.floor(duration) }
          : {}),
      });
      return NextResponse.json({ summary: `${summary}${concreteTodoAppendix}` });
    }

    const uniqueInsights = Array.isArray(insights)
      ? insights.filter(
          (
            item: { summary?: string },
            index: number,
            collection: Array<{ summary?: string }>
          ) =>
            index ===
            collection.findIndex(
              (candidate) =>
                normalizeSummaryKey(candidate.summary || '') === normalizeSummaryKey(item.summary || '')
            )
        )
      : [];

    const insightText = uniqueInsights
      .slice(-12)
      .map(
        (i: { timestamp: number; screenType: string; summary: string; keyPoints: string[] }) =>
          `[${new Date(i.timestamp).toLocaleTimeString()}] (${i.screenType}) ${i.summary}\n  - ${(i.keyPoints || []).join('\n  - ')}`
      )
      .join('\n\n');

    const transcriptText = (transcriptSegments || [])
      .slice(-24)
      .map(
        (segment: { timestamp: number; text: string }) =>
          `[${new Date(segment.timestamp).toLocaleTimeString()}] ${segment.text}`
      )
      .join('\n');

    const userPrompt = `You are writing the final summary for a completed meeting that lasted ${duration || 'unknown'} minutes.

Build one polished final summary that clearly combines:
- what was shown on screen
- what people said
- what got decided, committed to, or done

Visible timeline from the meeting:

${insightText}

Transcript from the meeting audio:
${transcriptText || 'No transcript captured.'}

Action items / commitments already extracted:
${concreteActionItems.map((item, i) => `${i + 1}. ${item}`).join('\n') || 'No explicit action items were pre-identified.'}

Write markdown with exactly these sections:
## Final Overview
2-4 sentences on what the meeting was about, what happened, and where it landed.

## What Was Shown
Flat bullet list of the most important visible work or materials.

## What Was Said
Flat bullet list of the most important spoken points, decisions, or clarifications.

## Decisions And Commitments
Flat bullet list of approvals, commitments, next steps, or notable changes in direction.
If none are clear, write "- No clear decisions or commitments captured."

## Action Items
Numbered list of concrete follow-ups with owner/deadline only when actually present.
If none are clear, write "1. No concrete action items identified."

## Open Questions
Flat bullet list of unresolved issues or things to clarify.

Rules:
- Integrate both speech and on-screen activity; do not summarize only one side.
- Prefer specifics over generic filler.
- If something is implied rather than explicit, use cautious wording like "appeared to" or "seemed to".
- Keep it concise, scannable, and useful as the single final recap the user sees after the meeting ends.`;

    const text = await completeText({ user: userPrompt, maxTokens: 1024 });
    return NextResponse.json({ summary: `${text}${concreteTodoAppendix}` });
  } catch (err) {
    console.error('summarize error:', err);
    const message = err instanceof Error ? err.message : 'Summarization failed';
    const isConfig = /API key|LLM configured|required for/i.test(message);
    const isRailtracks = /Railtracks/i.test(message);
    return NextResponse.json(
      { error: isConfig || isRailtracks ? message : 'Summarization failed' },
      { status: 500 }
    );
  }
}
