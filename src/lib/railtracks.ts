import type { CopilotChatHistoryMessage, ScreenAnalysisPayload } from '@/lib/meeting-copilot';

type RailtracksResponsePayload = {
  response?: unknown;
  error?: unknown;
};

export async function callRailtracksAgent(payload: {
  message: string;
  meetingContext?: string;
  screenAnalysis: ScreenAnalysisPayload | null;
  transcriptContext?: string;
  chatHistory?: CopilotChatHistoryMessage[];
}): Promise<string> {
  const baseUrl = process.env.RAILTRACKS_AGENT_URL?.trim();
  if (!baseUrl) {
    throw new Error('RAILTRACKS_AGENT_URL is not set');
  }

  const endpoint = `${baseUrl.replace(/\/$/, '')}/chat`;
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
  let data: RailtracksResponsePayload | null = null;

  if (rawBody) {
    try {
      data = JSON.parse(rawBody) as RailtracksResponsePayload;
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

  if (typeof data?.response !== 'string') {
    throw new Error('Railtracks agent returned an invalid response');
  }

  return data.response.trim();
}
