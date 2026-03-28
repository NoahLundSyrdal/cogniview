import { completeVision } from '@/lib/llm';
import { NextRequest, NextResponse } from 'next/server';

const FACT_CHECK_FLAG_MAX_ITEMS = 1;
const FACT_CHECK_FLAG_MIN_CHARS = 24;
const FACT_CHECK_FLAG_SIGNAL_RE =
  /\b\d[\d,.]*\b|%|\b(million|billion|thousand|percent|per cent|rate|odds|deaths?|killed|cases?|study|survey|research|report|according to)\b/i;

function parseDataUrlFrame(frame: string): { base64: string; mimeType: string } {
  const match = frame.match(/^data:(image\/[\w+.-]+);base64,(.+)$/);
  if (match) {
    return { mimeType: match[1], base64: match[2] };
  }
  return { mimeType: 'image/jpeg', base64: frame.replace(/^data:image\/\w+;base64,/, '') };
}

function normalizeFactCheckFlags(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const filtered: string[] = [];

  for (const item of value) {
    if (typeof item !== 'string') continue;

    const clean = item.replace(/\s+/g, ' ').trim();
    if (clean.length < FACT_CHECK_FLAG_MIN_CHARS) continue;
    if (!FACT_CHECK_FLAG_SIGNAL_RE.test(clean)) continue;

    const key = clean.toLowerCase().replace(/[^\w\s]/g, '');
    if (seen.has(key)) continue;
    seen.add(key);

    filtered.push(clean);
    if (filtered.length >= FACT_CHECK_FLAG_MAX_ITEMS) break;
  }

  return filtered;
}

export async function POST(req: NextRequest) {
  try {
    const { frame, previousContext } = await req.json();

    if (!frame) {
      return NextResponse.json({ error: 'No frame provided' }, { status: 400 });
    }

    const { base64, mimeType } = parseDataUrlFrame(frame);

    const prompt = `You are a meeting copilot analyzing a screen capture from an ongoing meeting or presentation. Your job is to extract useful, actionable insights.

Previous context from this meeting:
${previousContext || 'Meeting just started.'}

Analyze the current screen and respond with ONLY valid JSON (no markdown, no code blocks):
{
  "screenType": "slides|code|document|dashboard|video|browser|other",
  "summary": "1-2 sentence description of what is currently shown",
  "keyPoints": ["Important point 1", "Important point 2"],
  "suggestedQuestions": ["A clarifying question the viewer might want to ask"],
  "actionItems": ["Any action items visible or implied by the content"],
  "factCheckFlags": ["Any claims or statistics that might need verification"],
  "sceneSignature": "6-12 words capturing the core subject of this screen; keep stable across tiny scroll/layout changes",
  "contextForNext": "1 sentence context to carry forward for next frame analysis"
}

Rules:
- Be concise. Focus on what's NEW or IMPORTANT.
- Prioritize delta wording: if this frame is the same topic as the prior frame, summarize only what changed.
- Avoid repeating the same opening sentence from the previous insight when content is largely unchanged.
- keyPoints should have 1-3 items max.
- suggestedQuestions should have 0-2 items.
- actionItems should only include real tasks/todos.
- If the screen shows assignments, deadlines, deliverables, checklists, rubric requirements, or next steps, extract 1-3 concise actionItems from the screen.
- Prefer stable, canonical task wording so repeated views of the same assignment collapse cleanly. Example: "Submit Midterm Report by Wednesday 11:59pm" instead of several near-duplicates.
- For rubric or assignment pages, group overlapping requirements into compact deliverables instead of listing every line item separately.
- If the screen appears unchanged, prefer actionItems: [] to avoid spam, but still include explicit tasks when they are clearly actionable.
- Avoid repeating the same task unless there is materially new detail (owner, deadline, scope, or status).
- suggestedQuestions should only ask about information that is missing, ambiguous, or not clearly visible on the screen.
- Do not ask suggestedQuestions about dates, deadlines, names, or requirements that are already explicitly shown.
- When the screen clearly contains actionable work, prefer actionItems over suggestedQuestions.
- factCheckFlags should be conservative and sparse.
- Return at most 1 factCheckFlag, and only when there is a concrete, checkable claim with a number, statistic, or specific historical/scientific assertion.
- If uncertain whether a claim needs verification, return factCheckFlags: [].
- sceneSignature should stay the same if the screen is materially the same content with only minor scrolling or layout shifts.
- Reuse the previous sceneSignature when topic is unchanged.
- If screen appears unchanged from context, note that briefly.`;

    const text = await completeVision({
      prompt,
      base64,
      mimeType,
      maxTokens: 1024,
    });

    let analysis;
    try {
      analysis = JSON.parse(text);
    } catch {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        analysis = JSON.parse(jsonMatch[0]);
      } else {
        analysis = {
          screenType: 'other',
          summary: text,
          keyPoints: [],
          suggestedQuestions: [],
          actionItems: [],
          factCheckFlags: [],
          sceneSignature: '',
          contextForNext: text,
        };
      }
    }

    if (analysis && typeof analysis === 'object') {
      const typed = analysis as Record<string, unknown>;
      typed.factCheckFlags = normalizeFactCheckFlags(typed.factCheckFlags);
      analysis = typed;
    }

    return NextResponse.json(analysis);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('analyze-frame error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
