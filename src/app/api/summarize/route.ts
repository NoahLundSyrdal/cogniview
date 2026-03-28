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

function parseFirstJsonObject(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    return trimmed;
  }
  const match = trimmed.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  return match?.[0] ?? null;
}

async function consolidateActionItemsForSummary(params: {
  actionItems: string[];
  insights: unknown[];
  transcriptSegments: unknown[];
}): Promise<string[]> {
  const cleaned = params.actionItems
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);

  if (cleaned.length <= 1) return cleaned;

  const insightContext = Array.isArray(params.insights)
    ? params.insights
        .slice(-6)
        .map((item) => {
          if (!item || typeof item !== 'object') return '';
          const candidate = item as {
            screenType?: unknown;
            summary?: unknown;
            keyPoints?: unknown;
          };
          const keyPoints = Array.isArray(candidate.keyPoints)
            ? candidate.keyPoints.filter((value): value is string => typeof value === 'string').slice(0, 3)
            : [];
          return `(${typeof candidate.screenType === 'string' ? candidate.screenType : 'other'}) ${
            typeof candidate.summary === 'string' ? candidate.summary : ''
          }\n- ${keyPoints.join('\n- ')}`;
        })
        .filter(Boolean)
        .join('\n\n')
    : '';

  const transcriptContext = Array.isArray(params.transcriptSegments)
    ? params.transcriptSegments
        .slice(-8)
        .map((item) => {
          if (!item || typeof item !== 'object') return '';
          const candidate = item as { text?: unknown };
          return typeof candidate.text === 'string' ? candidate.text : '';
        })
        .filter(Boolean)
        .join('\n')
    : '';

  const raw = await completeText({
    system:
      'You consolidate overlapping meeting todo items into a compact, deduplicated checklist and return strict JSON.',
    user: `Candidate action items:
${cleaned.map((item, index) => `${index + 1}. ${item}`).join('\n')}

Recent screen context:
${insightContext || 'No recent screen context provided.'}

Recent transcript context:
${transcriptContext || 'No recent transcript context provided.'}

Merge items that refer to the same deliverable, deadline, or follow-up even if they use different wording, aliases, or assignment numbers.
- Keep only real action items.
- Prefer the clearest phrasing.
- Return JSON only in this exact shape: {"actionItems":["..."]}.
- Return at most 5 action items.
- If two items refer to the same assignment or deadline, keep one merged item.`,
    maxTokens: 500,
  });

  const jsonBlob = parseFirstJsonObject(raw);
  if (!jsonBlob) return cleaned.slice(0, 5);

  try {
    const parsed = JSON.parse(jsonBlob) as { actionItems?: unknown };
    if (!Array.isArray(parsed.actionItems)) return cleaned.slice(0, 5);
    return parsed.actionItems
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 5);
  } catch {
    return cleaned.slice(0, 5);
  }
}

export async function POST(req: NextRequest) {
  try {
    const { insights, actionItems, transcriptSegments, factCheckRuns, duration } = await req.json();
    const rawActionItems = Array.isArray(actionItems)
      ? actionItems
          .filter((item): item is string => typeof item === 'string')
          .map((item) => item.trim())
          .filter(Boolean)
      : [];
    const concreteActionItems = await consolidateActionItemsForSummary({
      actionItems: rawActionItems,
      insights: Array.isArray(insights) ? insights : [],
      transcriptSegments: Array.isArray(transcriptSegments) ? transcriptSegments : [],
    });

    if (!insights?.length && !transcriptSegments?.length) {
      return NextResponse.json({ error: 'No meeting data to summarize' }, { status: 400 });
    }

    if (process.env.RAILTRACKS_AGENT_URL?.trim()) {
      const summary = await callRailtracksSummary({
        insights: Array.isArray(insights) ? insights : [],
        actionItems: concreteActionItems,
        transcriptSegments: Array.isArray(transcriptSegments) ? transcriptSegments : [],
        factCheckRuns: Array.isArray(factCheckRuns) ? factCheckRuns : [],
        ...(typeof duration === 'number' && Number.isFinite(duration) && duration > 0
          ? { duration: Math.floor(duration) }
          : {}),
      });
      return NextResponse.json({ summary });
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

    const factCheckText = Array.isArray(factCheckRuns)
      ? factCheckRuns
          .slice(-4)
          .map((run, runIndex) => {
            if (!run || typeof run !== 'object') return '';
            const candidate = run as {
              timestamp?: number;
              results?: Array<{
                claim?: string;
                verdict?: string;
                summary?: string;
              }>;
            };
            const results = Array.isArray(candidate.results)
              ? candidate.results
                  .map((result) => {
                    if (!result || typeof result !== 'object') return '';
                    const item = result as {
                      claim?: string;
                      verdict?: string;
                      summary?: string;
                    };
                    const claim = typeof item.claim === 'string' ? item.claim : '';
                    const verdict = typeof item.verdict === 'string' ? item.verdict : '';
                    const summary = typeof item.summary === 'string' ? item.summary : '';
                    if (!claim || !verdict) return '';
                    return `- ${claim} (${verdict})${summary ? `: ${summary}` : ''}`;
                  })
                  .filter(Boolean)
              : [];

            if (!results.length) return '';

            const label =
              typeof candidate.timestamp === 'number'
                ? `[${new Date(candidate.timestamp).toLocaleTimeString()}]`
                : `[Run ${runIndex + 1}]`;

            return `${label}\n${results.join('\n')}`;
          })
          .filter(Boolean)
          .join('\n\n')
      : '';

    const userPrompt = `You are writing the final summary for a completed meeting that lasted ${duration || 'unknown'} minutes.

Build one polished final summary that clearly combines:
- what was shown on screen
- what people said
- what got decided, committed to, or done

Visible timeline from the meeting:

${insightText}

Transcript from the meeting audio:
${transcriptText || 'No transcript captured.'}

Fact-check findings captured during the meeting:
${factCheckText || 'No fact-check findings were captured.'}

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
- If there were fact-check findings, incorporate the most important ones into the recap where relevant.
- Prefer specifics over generic filler.
- Only include a todo list when the meeting clearly assigned or committed to follow-up work.
- Do not invent action items just because the summary has an Action Items section.
- Merge overlapping todos into the smallest useful checklist.
- Do not include near-duplicate tasks that differ only in wording.
- Keep the Action Items section short; prefer 3-5 high-signal tasks over a long list of repeated requirements.
- If something is implied rather than explicit, use cautious wording like "appeared to" or "seemed to".
- Keep it concise, scannable, and useful as the single final recap the user sees after the meeting ends.`;

    const text = await completeText({ user: userPrompt, maxTokens: 1024 });
    return NextResponse.json({ summary: text });
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
