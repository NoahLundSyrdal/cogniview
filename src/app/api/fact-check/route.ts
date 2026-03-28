import { NextRequest, NextResponse } from 'next/server';
import { extractClaimsFromImage, verifyClaimsWithWebSearch } from '@/lib/llm';

function parseDataUrlFrame(frame: string): { base64: string; mimeType: string } {
  const match = frame.match(/^data:(image\/[\w+.-]+);base64,(.+)$/);
  if (match) {
    return { mimeType: match[1], base64: match[2] };
  }
  return { mimeType: 'image/jpeg', base64: frame.replace(/^data:image\/\w+;base64,/, '') };
}

function parseEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

export async function POST(req: NextRequest) {
  try {
    const { frame, meetingContext } = await req.json();
    if (!frame || typeof frame !== 'string') {
      return NextResponse.json({ error: 'No frame provided' }, { status: 400 });
    }

    const { base64, mimeType } = parseDataUrlFrame(frame);
    const maxClaims = parseEnvInt('FACTCHECK_MAX_CLAIMS', 5);
    const claims = await extractClaimsFromImage({
      base64,
      mimeType,
      meetingContext: typeof meetingContext === 'string' ? meetingContext : undefined,
      maxClaims,
    });

    if (!claims.length) {
      return NextResponse.json({ claims: [], results: [] });
    }

    const results = await verifyClaimsWithWebSearch({
      claims,
      meetingContext: typeof meetingContext === 'string' ? meetingContext : undefined,
    });

    return NextResponse.json({ claims, results });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Fact-check failed';
    const isConfig = /API key|required|configured/i.test(message);
    return NextResponse.json({ error: isConfig ? message : 'Fact-check failed' }, { status: 500 });
  }
}
