'use client';

import { useEffect, useRef, useState } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import InsightCard from './InsightCard';
import MeetingControls from './MeetingControls';
import FactCheckPanel from './FactCheckPanel';
import AssistantCopilotChat from './AssistantCopilotChat';
import type { FrameAnalysis, FactCheckResult, MeetingSignal, TranscriptSegment } from '@/types';

function normalizeSignalKey(text: string) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatSignalTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
}

const SCREEN_REQUIREMENT_RE =
  /\b(due|deadline|required|required components|submit|submission|deliverable|assignment|rubric|guidelines|must|worth|points)\b/i;

function ActionSignalSection({
  title,
  emptyState,
  items,
}: {
  title: string;
  emptyState: string;
  items: MeetingSignal[];
}) {
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-950/70 px-3 py-3 space-y-2">
      <div className="text-[10px] uppercase tracking-[0.2em] text-gray-500">{title}</div>
      {items.length > 0 ? (
        <div className="space-y-2">
          {items.map((item) => (
            <div
              key={item.id}
              className="rounded-lg border border-gray-800/80 bg-gray-900/70 px-3 py-2 space-y-1.5"
            >
              <div className="flex items-center justify-between gap-2">
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.16em] ${
                    item.source === 'speech'
                      ? 'bg-emerald-500/15 text-emerald-200'
                      : 'bg-sky-500/15 text-sky-200'
                  }`}
                >
                  {item.source === 'speech' ? 'Voice' : 'Screen'}
                </span>
                <span className="text-[10px] text-gray-500">{formatSignalTime(item.timestamp)}</span>
              </div>
              <p className="text-xs leading-relaxed text-gray-200">{item.text}</p>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs leading-relaxed text-gray-500">{emptyState}</p>
      )}
    </div>
  );
}

interface Props {
  insights: FrameAnalysis[];
  chatMessageCount: number;
  isCapturing: boolean;
  isAnalyzing: boolean;
  isTranscribing: boolean;
  actionSignals: MeetingSignal[];
  decisionSignals: MeetingSignal[];
  openQuestionSignals: MeetingSignal[];
  transcriptSegments: TranscriptSegment[];
  finalSummary: string | null;
  finalSummaryError: string | null;
  isGeneratingSummary: boolean;
  onGenerateSummary: () => void;
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
  actionSignals,
  decisionSignals,
  openQuestionSignals,
  transcriptSegments,
  finalSummary,
  finalSummaryError,
  isGeneratingSummary,
  onGenerateSummary,
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
  const hasAutoFocusedActionsRef = useRef(false);

  useEffect(() => {
    if (isCapturing) {
      hasAutoFocusedActionsRef.current = false;
      return;
    }

    if (hasAutoFocusedActionsRef.current) return;
    if (!isGeneratingSummary && !finalSummary && !finalSummaryError) return;

    const frameId = requestAnimationFrame(() => {
      setTab('actions');
      hasAutoFocusedActionsRef.current = true;
    });

    return () => cancelAnimationFrame(frameId);
  }, [finalSummary, finalSummaryError, isCapturing, isGeneratingSummary]);

  const latestSuggestedQuestions = (() => {
    if (!screenAnalysis?.suggestedQuestions?.length) return [];
    const seen = new Set(openQuestionSignals.map((item) => normalizeSignalKey(item.text)));
    const items: MeetingSignal[] = [];

    screenAnalysis.suggestedQuestions.forEach((text, index) => {
      const key = normalizeSignalKey(text);
      if (!key || seen.has(key)) return;
      seen.add(key);
      items.push({
        id: `screen-question-${screenAnalysis.timestamp}-${index}`,
        text,
        timestamp: screenAnalysis.timestamp,
        source: 'vision',
      });
    });

    return items;
  })();

  const screenRequirements = (() => {
    const seen = new Set<string>();
    const items: MeetingSignal[] = [];

    [...insights]
      .slice(-6)
      .forEach((insight) => {
        const candidates = [...insight.keyPoints];
        if (SCREEN_REQUIREMENT_RE.test(insight.summary)) {
          candidates.unshift(insight.summary);
        }

        candidates.forEach((text, index) => {
          if (!SCREEN_REQUIREMENT_RE.test(text)) return;
          const key = normalizeSignalKey(text);
          if (!key || seen.has(key)) return;
          seen.add(key);
          items.push({
            id: `screen-requirement-${insight.timestamp}-${index}`,
            text,
            timestamp: insight.timestamp,
            source: 'vision',
          });
        });
      });

    return items.slice(-8).reverse();
  })();

  const actionCenterCount =
    actionSignals.length +
    decisionSignals.length +
    screenRequirements.length +
    openQuestionSignals.length +
    latestSuggestedQuestions.length;

  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: 'insights', label: 'Insights', count: insights.length || undefined },
    { id: 'transcript', label: 'Transcript', count: transcriptSegments.length || undefined },
    { id: 'actions', label: 'Actions', count: actionCenterCount || undefined },
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
              <ActionSignalSection
                title="Todos and deliverables"
                emptyState={
                  isCapturing
                    ? 'Watching for deadlines, required deliverables, and concrete follow-up work from the screen or conversation.'
                    : 'No concrete todos or deliverables were captured in this session.'
                }
                items={[...actionSignals].reverse().slice(0, 8)}
              />
              <ActionSignalSection
                title="Decisions heard"
                emptyState={
                  isCapturing
                    ? 'Listening for explicit approvals, chosen options, and changes in direction.'
                    : 'No explicit decisions were captured in this session.'
                }
                items={[...decisionSignals].reverse().slice(0, 6)}
              />
              <ActionSignalSection
                title="Deadlines and requirements on screen"
                emptyState={
                  isCapturing
                    ? 'Watching for due dates, assignment requirements, and submission constraints on screen.'
                    : 'No on-screen deadlines or requirements were captured in this session.'
                }
                items={screenRequirements}
              />
              <ActionSignalSection
                title="Questions and prompts"
                emptyState={
                  isCapturing
                    ? 'Watching for unresolved questions and useful prompts to ask next.'
                    : 'No unresolved questions or prompts were captured in this session.'
                }
                items={[...openQuestionSignals, ...latestSuggestedQuestions].reverse().slice(0, 8)}
              />
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
