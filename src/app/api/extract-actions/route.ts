import { NextRequest, NextResponse } from 'next/server';
import { extractMeetingSignalsFromTranscript } from '@/lib/llm';

function parseEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function parseEnvBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return fallback;
}

export async function POST(req: NextRequest) {
  try {
    const isEnabled = parseEnvBool('ENABLE_TRANSCRIPT_ACTION_EXTRACTION', true);
    if (!isEnabled) {
      return NextResponse.json({ actionItems: [], decisions: [], openQuestions: [] });
    }

    const { transcriptText, meetingContext } = await req.json();

    if (typeof transcriptText !== 'string' || !transcriptText.trim()) {
      return NextResponse.json({ actionItems: [], decisions: [], openQuestions: [] });
    }

    const maxItems = parseEnvInt('TRANSCRIPT_ACTION_MAX_ITEMS', 5);
    const meetingSignals = await extractMeetingSignalsFromTranscript({
      transcriptText,
      meetingContext: typeof meetingContext === 'string' ? meetingContext : undefined,
      maxItems,
    });

    return NextResponse.json(meetingSignals);
  } catch (err) {
    console.error('extract-actions error:', err);
    const message = err instanceof Error ? err.message : 'Action extraction failed';
    const isConfig = /API key|LLM configured|required for/i.test(message);
    return NextResponse.json(
      { error: isConfig ? message : 'Action extraction failed' },
      { status: 500 }
    );
  }
}
