import { completeVision } from '@/lib/llm';
import { NextRequest, NextResponse } from 'next/server';

function parseDataUrlFrame(frame: string): { base64: string; mimeType: string } {
  const match = frame.match(/^data:(image\/[\w+.-]+);base64,(.+)$/);
  if (match) {
    return { mimeType: match[1], base64: match[2] };
  }
  return { mimeType: 'image/jpeg', base64: frame.replace(/^data:image\/\w+;base64,/, '') };
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
  "contextForNext": "1 sentence context to carry forward for next frame analysis"
}

Rules:
- Be concise. Focus on what's NEW or IMPORTANT.
- keyPoints should have 1-3 items max.
- suggestedQuestions should have 0-2 items.
- actionItems should only include real tasks/todos.
- factCheckFlags only for specific claims with numbers or controversial statements.
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
          contextForNext: text,
        };
      }
    }

    return NextResponse.json(analysis);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('analyze-frame error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
