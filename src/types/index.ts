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

export interface TranscriptSegment {
  id: string;
  text: string;
  timestamp: number;
  durationSeconds?: number;
}

export interface MeetingState {
  isCapturing: boolean;
  isAnalyzing: boolean;
  insights: FrameAnalysis[];
  messages: ChatMessage[];
  context: string;
  allActionItems: string[];
  transcriptSegments: TranscriptSegment[];
}
