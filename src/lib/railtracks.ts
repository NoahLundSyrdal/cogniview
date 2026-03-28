import type { CopilotChatHistoryMessage, ScreenAnalysisPayload } from '@/lib/meeting-copilot';
import type { FactCheckResponsePayload } from '@/lib/fact-check';
import type {
  FactCheckResult,
  FactCheckSource,
  FactCheckStatement,
  FactCheckStatementSource,
} from '@/types';

type RailtracksResponsePayload = {
  response?: unknown;
  error?: unknown;
};

type RailtracksFactCheckPayload = {
  claims?: unknown;
  statements?: unknown;
  results?: unknown;
  error?: unknown;
};

type RailtracksSummaryPayload = {
  summary?: unknown;
  error?: unknown;
};

async function postRailtracks<T>(path: string, payload: unknown): Promise<T> {
  const baseUrl = process.env.RAILTRACKS_AGENT_URL?.trim();
  if (!baseUrl) {
    throw new Error('RAILTRACKS_AGENT_URL is not set');
  }

  const endpoint = `${baseUrl.replace(/\/$/, '')}${path}`;
  let response: Response;

  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      cache: 'no-store',
      body: JSON.stringify(payload),
    });
  } catch {
    throw new Error(`Railtracks agent is unavailable at ${endpoint}`);
  }

  const rawBody = await response.text();
  let data: { error?: unknown } | null = null;

  if (rawBody) {
    try {
      data = JSON.parse(rawBody) as { error?: unknown };
    } catch {
      data = null;
    }
  }

  if (!response.ok) {
    const message =
      typeof data?.error === 'string'
        ? data.error
        : `Railtracks agent request failed with status ${response.status}`;
    throw new Error(message);
  }

  return data as T;
}

function normalizeFactCheckSources(value: unknown): FactCheckSource[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return null;
      }

      const candidate = item as Record<string, unknown>;
      if (typeof candidate.url !== 'string' || !candidate.url.trim()) {
        return null;
      }

      return {
        title:
          typeof candidate.title === 'string' && candidate.title.trim()
            ? candidate.title.trim()
            : 'Source',
        url: candidate.url.trim(),
        snippet:
          typeof candidate.snippet === 'string' && candidate.snippet.trim()
            ? candidate.snippet.trim()
            : '',
      };
    })
    .filter((item): item is FactCheckSource => Boolean(item));
}

function normalizeFactCheckResults(value: unknown): FactCheckResult[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return null;
      }

      const candidate = item as Record<string, unknown>;
      const claim = typeof candidate.claim === 'string' ? candidate.claim.trim() : '';
      const summary = typeof candidate.summary === 'string' ? candidate.summary.trim() : '';
      const confidence =
        typeof candidate.confidence === 'number'
          ? Math.max(0, Math.min(1, candidate.confidence))
          : 0.2;
      const verdict =
        typeof candidate.verdict === 'string' ? candidate.verdict.trim().toLowerCase() : '';
      const source = normalizeStatementSource(candidate.source);

      if (!claim || !summary) {
        return null;
      }

      if (
        verdict !== 'supported' &&
        verdict !== 'contradicted' &&
        verdict !== 'mixed' &&
        verdict !== 'insufficient_evidence'
      ) {
        return null;
      }

      return {
        claim,
        source,
        verdict,
        confidence,
        summary,
        sources: normalizeFactCheckSources(candidate.sources),
      };
    })
    .filter((item): item is FactCheckResult => Boolean(item));
}

function normalizeStatementSource(value: unknown): FactCheckStatementSource {
  return value === 'voice' ? 'voice' : 'visual';
}

function normalizeFactCheckStatements(value: unknown): FactCheckStatement[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return null;
      }

      const candidate = item as Record<string, unknown>;
      const claim = typeof candidate.claim === 'string' ? candidate.claim.trim() : '';
      if (!claim) return null;
      const priority = typeof candidate.priority === 'number' ? candidate.priority : undefined;
      return {
        claim,
        source: normalizeStatementSource(candidate.source),
        ...(typeof priority === 'number' && Number.isFinite(priority) ? { priority } : {}),
      };
    })
    .filter((item): item is FactCheckStatement => Boolean(item));
}

export async function callRailtracksAgent(payload: {
  message: string;
  meetingContext?: string;
  screenAnalysis: ScreenAnalysisPayload | null;
  transcriptContext?: string;
  chatHistory?: CopilotChatHistoryMessage[];
}): Promise<string> {
  const data = await postRailtracks<RailtracksResponsePayload>('/chat', payload);
  if (typeof data?.response !== 'string') {
    throw new Error('Railtracks agent returned an invalid response');
  }

  return data.response.trim();
}

export async function callRailtracksFactCheck(payload: {
  frame: string;
  meetingContext?: string;
  screenContext?: string;
  transcriptContext?: string;
  maxClaims?: number;
}): Promise<FactCheckResponsePayload> {
  const data = await postRailtracks<RailtracksFactCheckPayload>('/fact-check', payload);
  const statements = normalizeFactCheckStatements(data?.statements);
  const claims = Array.isArray(data?.claims)
    ? data.claims.filter((claim): claim is string => typeof claim === 'string' && claim.trim().length > 0)
    : statements.map((statement) => statement.claim);

  return {
    claims,
    statements,
    results: normalizeFactCheckResults(data?.results),
  };
}

export async function callRailtracksSummary(payload: {
  insights: unknown[];
  actionItems: string[];
  transcriptSegments: unknown[];
  duration?: number;
}): Promise<string> {
  const data = await postRailtracks<RailtracksSummaryPayload>('/summarize', payload);
  if (typeof data?.summary !== 'string' || !data.summary.trim()) {
    throw new Error('Railtracks summary agent returned an invalid response');
  }

  return data.summary.trim();
}
