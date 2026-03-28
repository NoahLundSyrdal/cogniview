'use client';

import { useEffect, useRef, useState } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import InsightCard from './InsightCard';
import MeetingControls from './MeetingControls';
import FactCheckPanel from './FactCheckPanel';
import AssistantCopilotChat from './AssistantCopilotChat';
import type {
  FactCheckResult,
  FactCheckStatement,
  FrameAnalysis,
  TranscriptSegment,
} from '@/types';

interface Props {
  insights: FrameAnalysis[];
  chatMessageCount: number;
  isCapturing: boolean;
  isAnalyzing: boolean;
  isTranscribing: boolean;
  transcriptSegments: TranscriptSegment[];
  finalSummary: string | null;
  finalSummaryError: string | null;
  isGeneratingSummary: boolean;
  onGenerateSummary: () => void;
  factCheckClaims: string[];
  factCheckStatements: FactCheckStatement[];
  factCheckResults: FactCheckResult[];
  factCheckError: string | null;
  factCheckStatus: string | null;
  isFactChecking: boolean;
  onRunFactCheck: () => Promise<void>;
  meetingContext: string;
  screenAnalysis: FrameAnalysis | null;
  transcriptContext: string;
  chatSessionId: string;
  onChatMessageCountChange: (count: number) => void;
}

type Tab = 'insights' | 'chat' | 'factCheck' | 'summary';

export default function CopilotSidebar({
  insights,
  chatMessageCount,
  isCapturing,
  isAnalyzing,
  isTranscribing,
  transcriptSegments,
  finalSummary,
  finalSummaryError,
  isGeneratingSummary,
  onGenerateSummary,
  factCheckClaims,
  factCheckStatements,
  factCheckResults,
  factCheckError,
  factCheckStatus,
  isFactChecking,
  onRunFactCheck,
  meetingContext,
  screenAnalysis,
  transcriptContext,
  chatSessionId,
  onChatMessageCountChange,
}: Props) {
  const [tab, setTab] = useState<Tab>('insights');
  const hasAutoFocusedSummaryRef = useRef(false);
  const showSummaryTab =
    !isCapturing || isGeneratingSummary || Boolean(finalSummary) || Boolean(finalSummaryError);
  const activeTab: Tab = !showSummaryTab && tab === 'summary' ? 'insights' : tab;

  useEffect(() => {
    if (isCapturing) {
      hasAutoFocusedSummaryRef.current = false;
      return;
    }

    if (hasAutoFocusedSummaryRef.current) return;
    if (!isGeneratingSummary && !finalSummary && !finalSummaryError) return;

    const frameId = requestAnimationFrame(() => {
      setTab('summary');
      hasAutoFocusedSummaryRef.current = true;
    });

    return () => cancelAnimationFrame(frameId);
  }, [finalSummary, finalSummaryError, isCapturing, isGeneratingSummary]);

  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: 'insights', label: 'Insights', count: insights.length || undefined },
    { id: 'chat', label: 'Chat', count: chatMessageCount || undefined },
    { id: 'factCheck', label: 'Fact-check', count: factCheckResults.length || undefined },
    ...(showSummaryTab ? [{ id: 'summary' as const, label: 'Summary' }] : []),
  ];

  return (
    <div className="w-80 flex flex-col border-l border-gray-800 bg-gray-900">
      <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-gray-100">Copilot</span>
          {(isAnalyzing || isTranscribing) && (
            <span className="flex gap-0.5">
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  className="w-1 h-1 bg-indigo-400 rounded-full animate-bounce"
                  style={{ animationDelay: `${i * 100}ms` }}
                />
              ))}
            </span>
          )}
        </div>
        <div
          className={`w-2 h-2 rounded-full ${
            isCapturing ? 'bg-green-400 shadow-[0_0_6px_rgba(74,222,128,0.6)]' : 'bg-gray-600'
          }`}
        />
      </div>

      <div className="flex border-b border-gray-800">
        {tabs.map(({ id, label, count }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`flex-1 py-2 text-xs font-medium transition-colors ${
              activeTab === id
                ? 'text-indigo-300 border-b-2 border-indigo-500'
                : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            {label}
            {count !== undefined && (
              <span
                className={`ml-1.5 px-1.5 py-0.5 rounded-full text-[10px] ${
                  activeTab === id ? 'bg-indigo-500/30 text-indigo-300' : 'bg-gray-700 text-gray-400'
                }`}
              >
                {count}
              </span>
            )}
          </button>
        ))}
      </div>

      <div className="flex-1 min-h-0">
        {activeTab === 'insights' && (
          <ScrollArea className="h-full">
            <div className="p-3 space-y-3">
              {insights.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-center gap-3">
                  <span className="text-3xl opacity-40">👁</span>
                  <p className="text-sm text-gray-500">
                    {isCapturing ? 'Waiting for first frame...' : 'Start capture to see insights'}
                  </p>
                </div>
              ) : (
                [...insights].reverse().map((insight, index) => (
                  <InsightCard key={insight.timestamp} insight={insight} isLatest={index === 0} />
                ))
              )}
            </div>
          </ScrollArea>
        )}

        {activeTab === 'chat' && (
          <AssistantCopilotChat
            meetingContext={meetingContext}
            screenAnalysis={screenAnalysis}
            transcriptContext={transcriptContext}
            sessionId={chatSessionId}
            onMessageCountChange={onChatMessageCountChange}
          />
        )}

        {activeTab === 'factCheck' && (
          <ScrollArea className="h-full">
            <FactCheckPanel
              isCapturing={isCapturing}
              isRunning={isFactChecking}
              error={factCheckError}
              status={factCheckStatus}
              claims={factCheckClaims}
              statements={factCheckStatements}
              results={factCheckResults}
              onRun={onRunFactCheck}
            />
          </ScrollArea>
        )}

        {activeTab === 'summary' && showSummaryTab && (
          <ScrollArea className="h-full">
            <div className="p-3">
              <MeetingControls
                isCapturing={isCapturing}
                insights={insights}
                transcriptSegments={transcriptSegments}
                isGeneratingSummary={isGeneratingSummary}
                summary={finalSummary}
                summaryError={finalSummaryError}
                onGenerateSummary={onGenerateSummary}
              />
            </div>
          </ScrollArea>
        )}
      </div>
    </div>
  );
}
