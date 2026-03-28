export interface FrameAnalysis {
  screenType: 'slides' | 'code' | 'document' | 'dashboard' | 'video' | 'browser' | 'other';
  summary: string;
  keyPoints: string[];
  suggestedQuestions: string[];
  actionItems: string[];
  factCheckFlags: string[];
  contextForNext: string;
  timestamp: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface MeetingState {
  isCapturing: boolean;
  isAnalyzing: boolean;
  insights: FrameAnalysis[];
  messages: ChatMessage[];
  context: string;
  allActionItems: string[];
}

export type FactCheckVerdict = 'supported' | 'contradicted' | 'mixed' | 'insufficient_evidence';

export interface FactCheckClaim {
  claim: string;
}

export interface FactCheckSource {
  title: string;
  url: string;
  snippet: string;
}

export interface FactCheckResult {
  claim: string;
  verdict: FactCheckVerdict;
  confidence: number;
  summary: string;
  sources: FactCheckSource[];
}
