export interface FrameAnalysis {
  screenType: 'slides' | 'code' | 'document' | 'dashboard' | 'video' | 'browser' | 'other';
  summary: string;
  keyPoints: string[];
  suggestedQuestions: string[];
  actionItems: string[];
  factCheckFlags: string[];
  sceneSignature?: string;
  contextForNext: string;
  timestamp: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface TranscriptSegment {
  id: string;
  text: string;
  timestamp: number;
  durationSeconds?: number;
}

export type MeetingSignalSource = 'vision' | 'speech';

export interface MeetingSignal {
  id: string;
  text: string;
  timestamp: number;
  source: MeetingSignalSource;
}

export interface MeetingSignalsPayload {
  actionItems?: string[];
  decisions?: string[];
  openQuestions?: string[];
}

export interface MeetingState {
  isCapturing: boolean;
  isAnalyzing: boolean;
  insights: FrameAnalysis[];
  messages: ChatMessage[];
  context: string;
  allActionItems: string[];
  actionSignals: MeetingSignal[];
  decisionSignals: MeetingSignal[];
  openQuestionSignals: MeetingSignal[];
  transcriptSegments: TranscriptSegment[];
}

export type FactCheckVerdict = 'supported' | 'contradicted' | 'mixed' | 'insufficient_evidence';

export type FactCheckStatementSource = 'voice' | 'visual';

export interface FactCheckClaim {
  claim: string;
}

export interface FactCheckStatement {
  claim: string;
  source: FactCheckStatementSource;
  priority?: number;
}

export interface FactCheckSource {
  title: string;
  url: string;
  snippet: string;
}

export interface FactCheckResult {
  claim: string;
  source: FactCheckStatementSource;
  verdict: FactCheckVerdict;
  confidence: number;
  summary: string;
  sources: FactCheckSource[];
}
