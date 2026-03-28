'use client';

import { useState } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import InsightCard from './InsightCard';
import MeetingControls from './MeetingControls';
import FactCheckPanel from './FactCheckPanel';
import AssistantCopilotChat from './AssistantCopilotChat';
import type { FrameAnalysis, FactCheckResult, TranscriptSegment } from '@/types';

interface Props {
  insights: FrameAnalysis[];
  chatMessageCount: number;
  isCapturing: boolean;
  isAnalyzing: boolean;
  isTranscribing: boolean;
  allActionItems: string[];
  liveNowSummary: string;
  recentCommitments: string[];
  transcriptSegments: TranscriptSegment[];
  startTime: number | null;
  factCheckClaims: string[];
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

type Tab = 'insights' | 'transcript' | 'actions' | 'chat' | 'factCheck';

export default function CopilotSidebar({
  insights,
  chatMessageCount,
  isCapturing,
  isAnalyzing,
  isTranscribing,
  allActionItems,
  liveNowSummary,
  recentCommitments,
  transcriptSegments,
  startTime,
  factCheckClaims,
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

  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: 'insights', label: 'Insights', count: insights.length || undefined },
    { id: 'transcript', label: 'Transcript', count: transcriptSegments.length || undefined },
    { id: 'actions', label: 'Actions', count: allActionItems.length || undefined },
    { id: 'chat', label: 'Chat', count: chatMessageCount || undefined },
    { id: 'factCheck', label: 'Fact-check', count: factCheckResults.length || undefined },
  ];

  return (
    <div className="w-80 flex flex-col border-l border-gray-800 bg-gray-900">
      {/* Header */}
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

      {/* Tabs */}
      <div className="flex border-b border-gray-800">
        {tabs.map(({ id, label, count }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`flex-1 py-2 text-xs font-medium transition-colors ${
              tab === id
                ? 'text-indigo-300 border-b-2 border-indigo-500'
                : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            {label}
            {count !== undefined && (
              <span
                className={`ml-1.5 px-1.5 py-0.5 rounded-full text-[10px] ${
                  tab === id ? 'bg-indigo-500/30 text-indigo-300' : 'bg-gray-700 text-gray-400'
                }`}
              >
                {count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0">
        {tab === 'insights' && (
          <ScrollArea className="h-full">
            <div className="p-3 space-y-3">
              {insights.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-center gap-3">
                  <span className="text-3xl opacity-40">👁</span>
                  <p className="text-sm text-gray-500">
                    {isCapturing
                      ? 'Waiting for first frame...'
                      : 'Start capture to see insights'}
                  </p>
                </div>
              ) : (
                [...insights].reverse().map((insight, i) => (
                  <InsightCard key={insight.timestamp} insight={insight} isLatest={i === 0} />
                ))
              )}
            </div>
          </ScrollArea>
        )}

        {tab === 'transcript' && (
          <ScrollArea className="h-full">
            <div className="p-3 space-y-3">
              {isCapturing && (
                <div className="rounded-lg border border-indigo-500/20 bg-indigo-500/10 px-3 py-2 text-[11px] text-indigo-200">
                  {isTranscribing ? 'Listening live. New transcript text should land every ~5 seconds.' : 'Listening live.'}
                </div>
              )}
              {transcriptSegments.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-center gap-3">
                  <span className="text-3xl opacity-40">🎙</span>
                  <p className="text-sm text-gray-500">
                    {isCapturing
                      ? 'Listening for meeting audio...'
                      : 'Start capture to transcribe audio'}
                  </p>
                </div>
              ) : (
                [...transcriptSegments].reverse().map((segment) => (
                  <div
                    key={segment.id}
                    className="rounded-lg border border-gray-800 bg-gray-950/70 px-3 py-2.5 space-y-1.5"
                  >
                    <div className="text-[10px] uppercase tracking-[0.2em] text-gray-500">
                      {new Date(segment.timestamp).toLocaleTimeString()}
                    </div>
                    <p className="text-xs leading-relaxed text-gray-200">{segment.text}</p>
                  </div>
                ))
              )}
            </div>
          </ScrollArea>
        )}

        {tab === 'actions' && (
          <ScrollArea className="h-full">
            <div className="p-3 space-y-3">
              <div className="rounded-lg border border-gray-800 bg-gray-950/70 px-3 py-3 space-y-2">
                <div className="text-[10px] uppercase tracking-[0.2em] text-gray-500">
                  What is happening now
                </div>
                <p className="text-xs leading-relaxed text-gray-200 whitespace-pre-wrap">
                  {liveNowSummary ||
                    (isCapturing
                      ? 'Listening and watching. Waiting for enough context to summarize this moment.'
                      : 'Start capture to get a live summary of what is happening now.')}
                </p>
              </div>
              <div className="rounded-lg border border-gray-800 bg-gray-950/70 px-3 py-3 space-y-2">
                <div className="text-[10px] uppercase tracking-[0.2em] text-gray-500">
                  New commitments (last 2 min)
                </div>
                {recentCommitments.length > 0 ? (
                  <ul className="space-y-1.5 text-xs text-gray-200 list-disc pl-4">
                    {recentCommitments.map((item) => (
                      <li key={item} className="leading-relaxed">
                        {item}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs leading-relaxed text-gray-500">
                    No new commitments detected.
                  </p>
                )}
              </div>
              <MeetingControls
                insights={insights}
                actionItems={allActionItems}
                transcriptSegments={transcriptSegments}
                startTime={startTime}
              />
            </div>
          </ScrollArea>
        )}

        {tab === 'chat' && (
          <AssistantCopilotChat
            meetingContext={meetingContext}
            screenAnalysis={screenAnalysis}
            transcriptContext={transcriptContext}
            sessionId={chatSessionId}
            onMessageCountChange={onChatMessageCountChange}
          />
        )}

        {tab === 'factCheck' && (
          <ScrollArea className="h-full">
            <FactCheckPanel
              isCapturing={isCapturing}
              isRunning={isFactChecking}
              error={factCheckError}
              status={factCheckStatus}
              claims={factCheckClaims}
              results={factCheckResults}
              onRun={onRunFactCheck}
            />
          </ScrollArea>
        )}
      </div>
    </div>
  );
}
