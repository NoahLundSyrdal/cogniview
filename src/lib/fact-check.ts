import { extractClaimsFromImage, extractClaimsFromTranscript, verifyClaimsWithWebSearch } from '@/lib/llm';
import type { FactCheckResult, FactCheckStatement, FactCheckStatementSource } from '@/types';

export type FactCheckResponsePayload = {
  // Backward-compatible field kept while clients migrate.
  claims: string[];
  statements: FactCheckStatement[];
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

function parseEnvBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
    return true;
  }
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
    return false;
  }
  return fallback;
}

function normalizeClaimText(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function toStatements(claims: string[], source: FactCheckStatementSource, maxItems: number): FactCheckStatement[] {
  const seen = new Set<string>();
  const statements: FactCheckStatement[] = [];
  for (const claim of claims) {
    const clean = normalizeClaimText(claim);
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    statements.push({
      claim: clean,
      source,
      priority: statements.length + 1,
    });
    if (statements.length >= maxItems) break;
  }
  return statements;
}

function mergeStatements(
  visualStatements: FactCheckStatement[],
  voiceStatements: FactCheckStatement[],
  totalMaxItems: number
): FactCheckStatement[] {
  const merged: FactCheckStatement[] = [];
  const seen = new Set<string>();
  let visualIndex = 0;
  let voiceIndex = 0;

  while (merged.length < totalMaxItems && (visualIndex < visualStatements.length || voiceIndex < voiceStatements.length)) {
    const nextBatch: FactCheckStatement[] = [];
    if (visualIndex < visualStatements.length) {
      nextBatch.push(visualStatements[visualIndex]);
      visualIndex += 1;
    }
    if (voiceIndex < voiceStatements.length) {
      nextBatch.push(voiceStatements[voiceIndex]);
      voiceIndex += 1;
    }

    for (const statement of nextBatch) {
      const key = `${statement.source}:${statement.claim.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push({
        ...statement,
        priority: merged.length + 1,
      });
      if (merged.length >= totalMaxItems) break;
    }
  }

  return merged;
}

export async function runLegacyFactCheck(params: {
  frame: string;
  meetingContext?: string;
  screenContext?: string;
  transcriptContext?: string;
  maxClaims?: number;
}): Promise<FactCheckResponsePayload> {
  const { base64, mimeType } = parseDataUrlFrame(params.frame);
  const maxClaims = params.maxClaims ?? parseEnvInt('FACTCHECK_MAX_CLAIMS', 5);
  const maxVisualStatements = parseEnvInt('FACTCHECK_MAX_VISUAL_STATEMENTS', maxClaims);
  const maxVoiceStatements = parseEnvInt('FACTCHECK_MAX_VOICE_STATEMENTS', maxClaims);
  const enableTranscriptExtraction = parseEnvBool('ENABLE_TRANSCRIPT_FACTCHECK_EXTRACTION', true);
  const [visualClaims, voiceClaims] = await Promise.all([
    extractClaimsFromImage({
      base64,
      mimeType,
      meetingContext: params.screenContext,
      maxClaims: Math.max(1, Math.min(maxClaims, maxVisualStatements)),
    }),
    enableTranscriptExtraction
      ? extractClaimsFromTranscript({
          transcriptText: params.transcriptContext ?? '',
          meetingContext: params.meetingContext,
          maxClaims: Math.max(1, Math.min(maxClaims, maxVoiceStatements)),
        })
      : Promise.resolve([]),
  ]);

  const visualStatements = toStatements(visualClaims, 'visual', maxVisualStatements);
  const voiceStatements = toStatements(voiceClaims, 'voice', maxVoiceStatements);
  const statements = mergeStatements(visualStatements, voiceStatements, maxClaims);

  if (!statements.length) {
    return { claims: [], statements: [], results: [] };
  }

  const results = await verifyClaimsWithWebSearch({
    statements,
    meetingContext: params.meetingContext,
  });

  return {
    claims: statements.map((statement) => statement.claim),
    statements,
    results,
  };
}
