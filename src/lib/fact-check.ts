import { extractClaimsFromImage, verifyClaimsWithWebSearch } from '@/lib/llm';
import type { FactCheckResult } from '@/types';

export type FactCheckResponsePayload = {
  claims: string[];
  results: FactCheckResult[];
};

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

export async function runLegacyFactCheck(params: {
  frame: string;
  meetingContext?: string;
  maxClaims?: number;
}): Promise<FactCheckResponsePayload> {
  const { base64, mimeType } = parseDataUrlFrame(params.frame);
  const maxClaims = params.maxClaims ?? parseEnvInt('FACTCHECK_MAX_CLAIMS', 5);
  const claims = await extractClaimsFromImage({
    base64,
    mimeType,
    meetingContext: params.meetingContext,
    maxClaims,
  });

  if (!claims.length) {
    return { claims: [], results: [] };
  }

  const results = await verifyClaimsWithWebSearch({
    claims,
    meetingContext: params.meetingContext,
  });

  return { claims, results };
}
