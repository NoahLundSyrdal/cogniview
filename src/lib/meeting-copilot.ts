export type ScreenAnalysisPayload = {
  screenType?: string;
  summary?: string;
  keyPoints?: string[];
  actionItems?: string[];
};

export type CopilotChatHistoryMessage = {
  role: 'user' | 'assistant';
  content: string;
};

export function normalizeStringArray(values: unknown): string[] {
  if (!Array.isArray(values)) {
    return [];
  }

  return values
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim());
}

export function normalizeScreenAnalysis(value: unknown): ScreenAnalysisPayload | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const screenType =
    typeof candidate.screenType === 'string' && candidate.screenType.trim().length > 0
      ? candidate.screenType
      : undefined;
  const summary =
    typeof candidate.summary === 'string' && candidate.summary.trim().length > 0
      ? candidate.summary
      : undefined;
  const keyPoints = normalizeStringArray(candidate.keyPoints);
  const actionItems = normalizeStringArray(candidate.actionItems);

  if (!screenType && !summary && keyPoints.length === 0 && actionItems.length === 0) {
    return null;
  }

  return {
    ...(screenType ? { screenType } : {}),
    ...(summary ? { summary } : {}),
    keyPoints,
    actionItems,
  };
}

export function buildScreenContext(screenAnalysis: ScreenAnalysisPayload | null): string {
  if (!screenAnalysis) {
    return 'No screen capture active yet.';
  }

  const screenType = screenAnalysis.screenType || 'Unknown screen';
  const summary = screenAnalysis.summary || 'No screen summary available.';
  const keyPoints = screenAnalysis.keyPoints?.join(', ') || 'None';
  const actionItems = screenAnalysis.actionItems?.join(', ') || 'None';

  return `Current screen: ${screenType} - ${summary}
Key points: ${keyPoints}
Action items identified: ${actionItems}`;
}

export function buildChatHistoryText(chatHistory: CopilotChatHistoryMessage[]): string | null {
  const lines = chatHistory
    .slice(-10)
    .map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.content.trim()}`)
    .filter((line) => !line.endsWith(':'));

  return lines.length > 0 ? lines.join('\n') : null;
}

export function buildSystemPrompt(params: {
  meetingContext?: string;
  screenAnalysis: ScreenAnalysisPayload | null;
  transcriptContext?: string;
  chatHistoryText?: string | null;
}): string {
  const priorChatSection = params.chatHistoryText?.trim()
    ? `Recent copilot chat:
${params.chatHistoryText}

`
    : '';

  return `You are an intelligent meeting copilot. You are watching the user's screen in real-time during their meeting.

${buildScreenContext(params.screenAnalysis)}

Meeting history so far:
${params.meetingContext || 'Meeting just started.'}

Recent spoken transcript:
${params.transcriptContext || 'No transcript available yet.'}

${priorChatSection}Your role:
- Answer questions about what's being presented on screen
- Suggest questions the user could ask the presenter
- Highlight important points or action items
- Provide relevant context, facts, or definitions
- Be concise and actionable - this is a live meeting, brevity matters
- If asked about something not visible, say so honestly

Respond in 1-3 sentences unless a detailed explanation is genuinely needed.`;
}
