import { NextRequest, NextResponse } from 'next/server';
import { runLegacyFactCheck } from '@/lib/fact-check';
import { callRailtracksFactCheck } from '@/lib/railtracks';

export const runtime = 'nodejs';

type FactCheckRequestPayload = {
  frame?: string;
  meetingContext?: string;
  maxClaims?: number;
};

export async function POST(req: NextRequest) {
  try {
    const { frame, meetingContext, maxClaims } = (await req.json()) as FactCheckRequestPayload;
    if (!frame || typeof frame !== 'string') {
      return NextResponse.json({ error: 'No frame provided' }, { status: 400 });
    }

    const normalizedPayload = {
      frame,
      ...(typeof meetingContext === 'string' ? { meetingContext } : {}),
      ...(typeof maxClaims === 'number' && Number.isFinite(maxClaims) && maxClaims > 0
        ? { maxClaims: Math.floor(maxClaims) }
        : {}),
    };

    if (process.env.RAILTRACKS_AGENT_URL?.trim()) {
      const response = await callRailtracksFactCheck(normalizedPayload);
      return NextResponse.json(response);
    }

    const response = await runLegacyFactCheck(normalizedPayload);
    return NextResponse.json(response);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Fact-check failed';
    const isConfig = /API key|required|configured/i.test(message);
    const isRailtracks = /Railtracks/i.test(message);
    return NextResponse.json(
      { error: isConfig || isRailtracks ? message : 'Fact-check failed' },
      { status: 500 }
    );
  }
}
