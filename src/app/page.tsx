'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';
import { useScreenCapture } from '@/hooks/useScreenCapture';
import { useDetachedWindow } from '@/hooks/useDetachedWindow';
import { useMeetingContext } from '@/hooks/useMeetingContext';
import ScreenCapture from '@/components/ScreenCapture';
import CopilotSidebar from '@/components/CopilotSidebar';
import FinalSummaryCard from '@/components/FinalSummaryCard';
import { cn } from '@/lib/utils';
import type { FrameAnalysis, FactCheckResult } from '@/types';

const TRANSCRIPT_ACTION_INTERVAL_MS = 15000;
const TRANSCRIPT_ACTION_MAX_CHARS = 2000;
const DEFAULT_COMMITMENTS_WINDOW_MS = 120000;
const DEFAULT_COMMITMENTS_MAX_ITEMS = 2;

const DUPLICATE_INSIGHT_SUMMARY_THRESHOLD = 0.58;
const DUPLICATE_INSIGHT_LIST_THRESHOLD = 0.5;
const DUPLICATE_INSIGHT_COMBINED_THRESHOLD = 0.64;
const DUPLICATE_INSIGHT_MEDIUM_THRESHOLD = 0.42;
const DUPLICATE_INSIGHT_WINDOW_MS = 45000;
const DUPLICATE_INSIGHT_RECENT_LIMIT = 6;
const DOMAIN_RE = /\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi;
const QUOTED_TEXT_RE = /["'“”‘’]([^"'“”‘’]{8,160})["'“”‘’]/g;

function parsePositiveInt(raw: string | undefined, fallback: number) {
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function normalizeInsightText(text: string) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeInsightText(text: string) {
  const normalized = normalizeInsightText(text);
  return normalized ? normalized.split(' ') : [];
}

function buildInsightCombinedText(analysis: FrameAnalysis) {
  return [
    analysis.sceneSignature || '',
    analysis.summary,
    ...analysis.keyPoints,
    ...analysis.suggestedQuestions,
    ...analysis.factCheckFlags,
    ...analysis.actionItems,
  ]
    .map(normalizeInsightText)
    .filter(Boolean)
    .join(' ');
}

function extractSalientMarkers(analysis: FrameAnalysis) {
  const markers = new Set<string>();
  const sourceTexts = [
    analysis.sceneSignature || '',
    analysis.summary,
    ...analysis.keyPoints,
    ...analysis.suggestedQuestions,
    ...analysis.factCheckFlags,
  ];

  for (const rawText of sourceTexts) {
    if (!rawText) continue;

    const domainMatches = rawText.match(DOMAIN_RE) || [];
    for (const match of domainMatches) {
      const normalized = normalizeInsightText(match);
      if (normalized) {
        markers.add(normalized);
      }
    }

    for (const match of rawText.matchAll(QUOTED_TEXT_RE)) {
      const normalized = normalizeInsightText(match[1] || '');
      if (normalized) {
        markers.add(normalized);
      }
    }
  }

  return markers;
}

function jaccardSimilarity(left: string[], right: string[]) {
  if (left.length === 0 && right.length === 0) return 1;
  if (left.length === 0 || right.length === 0) return 0;

  const leftSet = new Set(left);
  const rightSet = new Set(right);
  let intersection = 0;
  for (const token of leftSet) {
    if (rightSet.has(token)) {
      intersection += 1;
    }
  }

  const union = new Set([...leftSet, ...rightSet]).size;
  return union === 0 ? 0 : intersection / union;
}

function listSimilarity(left: string[], right: string[]) {
  const leftTokens = left.map(normalizeInsightText).filter(Boolean);
  const rightTokens = right.map(normalizeInsightText).filter(Boolean);
  return jaccardSimilarity(leftTokens, rightTokens);
}

function isNearDuplicateInsight(previous: FrameAnalysis | null, next: FrameAnalysis) {
  if (!previous) return false;
  if (previous.screenType !== next.screenType) return false;

  const previousSignature = normalizeInsightText(previous.sceneSignature || '');
  const nextSignature = normalizeInsightText(next.sceneSignature || '');
  if (previousSignature && nextSignature && previousSignature === nextSignature) {
    return true;
  }

  const summarySimilarity = jaccardSimilarity(
    tokenizeInsightText(previous.summary),
    tokenizeInsightText(next.summary)
  );
  const keyPointSimilarity = listSimilarity(previous.keyPoints, next.keyPoints);
  const questionSimilarity = listSimilarity(previous.suggestedQuestions, next.suggestedQuestions);
  const flagSimilarity = listSimilarity(previous.factCheckFlags, next.factCheckFlags);
  const actionSimilarity = listSimilarity(previous.actionItems, next.actionItems);
  const combinedSimilarity = jaccardSimilarity(
    tokenizeInsightText(buildInsightCombinedText(previous)),
    tokenizeInsightText(buildInsightCombinedText(next))
  );
  const previousMarkers = extractSalientMarkers(previous);
  const nextMarkers = extractSalientMarkers(next);
  const sharesMarker = [...previousMarkers].some((marker) => nextMarkers.has(marker));

  const structurallySame =
    keyPointSimilarity >= DUPLICATE_INSIGHT_LIST_THRESHOLD &&
    questionSimilarity >= DUPLICATE_INSIGHT_LIST_THRESHOLD &&
    flagSimilarity >= DUPLICATE_INSIGHT_LIST_THRESHOLD &&
    actionSimilarity >= DUPLICATE_INSIGHT_LIST_THRESHOLD;

  return (
    combinedSimilarity >= DUPLICATE_INSIGHT_COMBINED_THRESHOLD ||
    (sharesMarker && combinedSimilarity >= DUPLICATE_INSIGHT_MEDIUM_THRESHOLD) ||
    (summarySimilarity >= DUPLICATE_INSIGHT_SUMMARY_THRESHOLD &&
      (structurallySame || combinedSimilarity >= DUPLICATE_INSIGHT_LIST_THRESHOLD))
  );
}

export default function Home() {
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [transcriptError, setTranscriptError] = useState<string | null>(null);
  const [activeTranscriptJobs, setActiveTranscriptJobs] = useState(0);
  const [activeTranscriptActionJobs, setActiveTranscriptActionJobs] = useState(0);
  const [assistantChatMessageCount, setAssistantChatMessageCount] = useState(0);
  const [chatSessionId, setChatSessionId] = useState(() => crypto.randomUUID());
  const [startTime, setStartTime] = useState<number | null>(null);
  const [finalSummary, setFinalSummary] = useState<string | null>(null);
  const [finalSummaryError, setFinalSummaryError] = useState<string | null>(null);
  const [isGeneratingFinalSummary, setIsGeneratingFinalSummary] = useState(false);
  const [shouldGenerateFinalSummary, setShouldGenerateFinalSummary] = useState(false);
  const [isFactChecking, setIsFactChecking] = useState(false);
  const [factCheckError, setFactCheckError] = useState<string | null>(null);
  const [factCheckStatus, setFactCheckStatus] = useState<string | null>(null);
  const [factCheckClaims, setFactCheckClaims] = useState<string[]>([]);
  const [factCheckResults, setFactCheckResults] = useState<FactCheckResult[]>([]);
  const insightsRef = useRef<FrameAnalysis[]>([]);
  const latestAnalysisRef = useRef<FrameAnalysis | null>(null);
  const transcriptQueueRef = useRef<Promise<void>>(Promise.resolve());
  const transcriptActionQueueRef = useRef<Promise<void>>(Promise.resolve());
  const lastTranscriptActionRunAtRef = useRef(0);
  const lastTranscriptActionInputRef = useRef('');
  const latestFrameRef = useRef<string | null>(null);
  const lastFactCheckedFrameRef = useRef<string | null>(null);
  const pendingFactCheckFrameRef = useRef<string | null>(null);
  const isFactCheckingRef = useRef(false);
  const meetingSessionIdRef = useRef(0);
  const {
    isOpen: isSidebarDetached,
    mode: detachedSidebarMode,
    portalContainer: detachedSidebarContainer,
    openWindow: openSidebarWindow,
    focusWindow: focusSidebarWindow,
    closeWindow: closeSidebarWindow,
  } = useDetachedWindow({
    title: 'CogniView Copilot',
    name: 'cogniview-copilot',
    features: 'popup=yes,width=420,height=880,resizable=yes,scrollbars=no',
    pictureInPicture: {
      width: 420,
      height: 880,
    },
  });

  const {
    insights,
    context,
    allActionItems,
    transcriptSegments,
    addInsight,
    addActionItems,
    addTranscriptSegment,
    getTranscriptSummary,
    getContextSummary,
    getLiveNowSummary,
    getRecentCommitments,
    reset,
  } = useMeetingContext();
  const commitmentsWindowMs = parsePositiveInt(
    process.env.NEXT_PUBLIC_COMMITMENTS_WINDOW_MS,
    DEFAULT_COMMITMENTS_WINDOW_MS
  );
  const commitmentsMaxItems = parsePositiveInt(
    process.env.NEXT_PUBLIC_COMMITMENTS_MAX_ITEMS,
    DEFAULT_COMMITMENTS_MAX_ITEMS
  );
  const hasMeetingData = insights.length > 0 || transcriptSegments.length > 0;

  useEffect(() => {
    insightsRef.current = insights;
  }, [insights]);

  const generateFinalSummary = useCallback(async (sessionId: number) => {
    if (!hasMeetingData) {
      if (meetingSessionIdRef.current === sessionId) {
        setIsGeneratingFinalSummary(false);
      }
      return;
    }

    try {
      const duration = startTime ? Math.max(1, Math.round((Date.now() - startTime) / 60000)) : undefined;
      const res = await fetch('/api/summarize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          insights,
          actionItems: allActionItems,
          transcriptSegments,
          duration,
        }),
      });
      const data = await res.json();

      if (meetingSessionIdRef.current !== sessionId) return;

      if (!res.ok) {
        setFinalSummary(null);
        setFinalSummaryError(data.error || `Final summary failed (HTTP ${res.status})`);
        return;
      }

      const nextSummary = typeof data.summary === 'string' ? data.summary.trim() : '';
      setFinalSummary(nextSummary || null);
      setFinalSummaryError(nextSummary ? null : 'No final summary was generated.');
    } catch (err) {
      console.error('Final summary failed:', err);
      if (meetingSessionIdRef.current !== sessionId) return;
      setFinalSummary(null);
      setFinalSummaryError('Network error while generating the final summary.');
    } finally {
      if (meetingSessionIdRef.current === sessionId) {
        setIsGeneratingFinalSummary(false);
      }
    }
  }, [allActionItems, hasMeetingData, insights, startTime, transcriptSegments]);

  const requestFinalSummary = useCallback(() => {
    if (!hasMeetingData) return;
    setFinalSummary(null);
    setFinalSummaryError(null);
    setIsGeneratingFinalSummary(true);
    setShouldGenerateFinalSummary(true);
  }, [hasMeetingData]);

  const runFactCheckForFrame = useCallback(
    async (frame: string) => {
      pendingFactCheckFrameRef.current = null;
      setFactCheckStatus(null);
      setFactCheckError(null);
      setIsFactChecking(true);
      isFactCheckingRef.current = true;

      try {
        const res = await fetch('/api/fact-check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            frame,
            meetingContext: getContextSummary(),
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          setFactCheckError(data.error || 'Fact-check failed');
          return;
        }
        lastFactCheckedFrameRef.current = frame;
        setFactCheckClaims(Array.isArray(data.claims) ? data.claims : []);
        setFactCheckResults(Array.isArray(data.results) ? data.results : []);
      } catch (err) {
        console.error('Fact-check failed:', err);
        setFactCheckError('Network error. Please try again.');
      } finally {
        setIsFactChecking(false);
        isFactCheckingRef.current = false;
      }
    },
    [getContextSummary]
  );

  const handleFrame = useCallback(
    async (frame: string) => {
      latestFrameRef.current = frame;
      if (
        pendingFactCheckFrameRef.current &&
        frame !== pendingFactCheckFrameRef.current &&
        !isFactCheckingRef.current
      ) {
        void runFactCheckForFrame(frame);
      }
      setIsAnalyzing(true);
      setAnalysisError(null);
      const transcriptSummary = getTranscriptSummary();

      try {
        const res = await fetch('/api/analyze-frame', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            frame,
            previousContext: [
              context,
              transcriptSummary && `Recent transcript:\n${transcriptSummary}`,
            ]
              .filter(Boolean)
              .join('\n\n'),
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          setAnalysisError(data.error || `Analysis failed (HTTP ${res.status})`);
        } else {
          const analysis: FrameAnalysis = {
            ...data,
            sceneSignature:
              typeof data.sceneSignature === 'string' ? data.sceneSignature.trim() : '',
            timestamp: Date.now(),
          };
          const recentInsights = insightsRef.current
            .filter((item) => analysis.timestamp - item.timestamp <= DUPLICATE_INSIGHT_WINDOW_MS)
            .slice(-DUPLICATE_INSIGHT_RECENT_LIMIT);
          if (recentInsights.some((item) => isNearDuplicateInsight(item, analysis))) {
            return;
          }
          addInsight(analysis);
          latestAnalysisRef.current = analysis;
        }
      } catch (err) {
        setAnalysisError('Network error — check your connection.');
        console.error('Frame analysis failed:', err);
      }
      setIsAnalyzing(false);
    },
    [context, addInsight, getTranscriptSummary, runFactCheckForFrame]
  );

  const handleAudioChunk = useCallback(
    async (audio: Blob) => {
      transcriptQueueRef.current = transcriptQueueRef.current
        .catch(() => undefined)
        .then(async () => {
          setActiveTranscriptJobs((count) => count + 1);
          setTranscriptError(null);

          try {
            const extension = audio.type.includes('ogg') ? 'ogg' : 'webm';
            const formData = new FormData();
            formData.append('file', audio, `meeting-audio-${Date.now()}.${extension}`);

            const res = await fetch('/api/transcribe-audio', {
              method: 'POST',
              body: formData,
            });
            const data = await res.json();

            if (!res.ok) {
              setTranscriptError(data.error || `Audio transcription failed (HTTP ${res.status})`);
              return;
            }

            if (data.text?.trim()) {
              addTranscriptSegment({ text: data.text });
            }
          } catch (err) {
            console.error('Audio transcription failed:', err);
            setTranscriptError('Network error while transcribing audio.');
          } finally {
            setActiveTranscriptJobs((count) => Math.max(0, count - 1));
          }
        });

      await transcriptQueueRef.current;
    },
    [addTranscriptSegment]
  );

  const extractCommitmentsFromTranscript = useCallback(async () => {
    const transcriptText = getTranscriptSummary().slice(-TRANSCRIPT_ACTION_MAX_CHARS).trim();
    if (!transcriptText) return;
    if (transcriptText === lastTranscriptActionInputRef.current) return;

    const now = Date.now();
    if (now - lastTranscriptActionRunAtRef.current < TRANSCRIPT_ACTION_INTERVAL_MS) return;

    lastTranscriptActionRunAtRef.current = now;
    lastTranscriptActionInputRef.current = transcriptText;
    const meetingContext = getContextSummary();

    transcriptActionQueueRef.current = transcriptActionQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        setActiveTranscriptActionJobs((count) => count + 1);
        try {
          const res = await fetch('/api/extract-actions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ transcriptText, meetingContext }),
          });
          const data = await res.json();
          if (!res.ok) return;
          if (Array.isArray(data.actionItems) && data.actionItems.length > 0) {
            addActionItems(data.actionItems);
          }
        } catch (err) {
          console.error('Transcript commitment extraction failed:', err);
        } finally {
          setActiveTranscriptActionJobs((count) => Math.max(0, count - 1));
        }
      });

    await transcriptActionQueueRef.current;
  }, [addActionItems, getContextSummary, getTranscriptSummary]);

  const { isCapturing, captureError, startCapture, stopCapture } = useScreenCapture({
    onFrame: handleFrame,
    onAudioChunk: handleAudioChunk,
  });
  const showMainScreenSummary =
    !isCapturing &&
    hasMeetingData &&
    (isGeneratingFinalSummary || Boolean(finalSummary) || Boolean(finalSummaryError));

  useEffect(() => {
    if (!shouldGenerateFinalSummary) return;
    if (isCapturing || isAnalyzing || activeTranscriptJobs > 0 || activeTranscriptActionJobs > 0) {
      return;
    }

    const sessionId = meetingSessionIdRef.current;
    setShouldGenerateFinalSummary(false);
    void generateFinalSummary(sessionId);
  }, [
    activeTranscriptActionJobs,
    activeTranscriptJobs,
    generateFinalSummary,
    isAnalyzing,
    isCapturing,
    shouldGenerateFinalSummary,
  ]);

  useEffect(() => {
    if (!isCapturing || transcriptSegments.length === 0) return;
    void extractCommitmentsFromTranscript();
  }, [extractCommitmentsFromTranscript, isCapturing, transcriptSegments]);

  const handleStart = useCallback(async () => {
    meetingSessionIdRef.current += 1;
    const sidebarWindowPromise = openSidebarWindow().catch((error) => {
      console.error('Opening floating sidebar failed:', error);
      return false;
    });

    reset();
    setStartTime(null);
    setAnalysisError(null);
    setTranscriptError(null);
    setActiveTranscriptJobs(0);
    setActiveTranscriptActionJobs(0);
    setAssistantChatMessageCount(0);
    setChatSessionId(crypto.randomUUID());
    setFinalSummary(null);
    setFinalSummaryError(null);
    setIsGeneratingFinalSummary(false);
    setShouldGenerateFinalSummary(false);
    transcriptQueueRef.current = Promise.resolve();
    transcriptActionQueueRef.current = Promise.resolve();
    lastTranscriptActionRunAtRef.current = 0;
    lastTranscriptActionInputRef.current = '';
    latestFrameRef.current = null;
    setFactCheckError(null);
    setFactCheckStatus(null);
    setFactCheckClaims([]);
    setFactCheckResults([]);
    lastFactCheckedFrameRef.current = null;
    pendingFactCheckFrameRef.current = null;
    isFactCheckingRef.current = false;
    const didStart = await startCapture();

    if (!didStart) {
      if (await sidebarWindowPromise) {
        closeSidebarWindow();
      }
      return;
    }

    setStartTime(Date.now());
  }, [closeSidebarWindow, openSidebarWindow, reset, startCapture]);

  const handleStop = useCallback(() => {
    pendingFactCheckFrameRef.current = null;
    setFactCheckStatus(null);
    stopCapture();
    requestFinalSummary();
  }, [requestFinalSummary, stopCapture]);

  const handleRunFactCheck = useCallback(async () => {
    const latestFrame = latestFrameRef.current;
    if (!latestFrame) {
      setFactCheckError('No captured frame available yet.');
      setFactCheckStatus(null);
      return;
    }

    if (latestFrame === lastFactCheckedFrameRef.current) {
      pendingFactCheckFrameRef.current = latestFrame;
      setFactCheckError(null);
      setFactCheckStatus(
        'Screen is unchanged. Waiting for a new screen before running fact-check again.'
      );
      return;
    }

    await runFactCheckForFrame(latestFrame);
  }, [runFactCheckForFrame]);

  const sidebarProps = {
    insights,
    chatMessageCount: assistantChatMessageCount,
    isCapturing,
    isAnalyzing: isAnalyzing || activeTranscriptJobs > 0,
    isTranscribing: activeTranscriptJobs > 0,
    allActionItems,
    liveNowSummary: getLiveNowSummary(),
    recentCommitments: getRecentCommitments(commitmentsWindowMs, commitmentsMaxItems),
    transcriptSegments,
    finalSummary,
    finalSummaryError,
    isGeneratingSummary: isGeneratingFinalSummary,
    onGenerateSummary: requestFinalSummary,
    factCheckClaims,
    factCheckResults,
    factCheckError,
    factCheckStatus,
    isFactChecking,
    onRunFactCheck: handleRunFactCheck,
    meetingContext: getContextSummary(),
    screenAnalysis: latestAnalysisRef.current,
    transcriptContext: getTranscriptSummary(),
    chatSessionId,
    onChatMessageCountChange: setAssistantChatMessageCount,
  };

  return (
    <>
      <div className="flex h-screen bg-gray-950 text-white overflow-hidden">
        {/* Main area */}
        <div
          className={cn(
            'flex-1 flex flex-col items-center p-8 relative overflow-y-auto',
            showMainScreenSummary ? 'justify-start' : 'justify-center'
          )}
        >
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(99,102,241,0.08)_0%,transparent_70%)] pointer-events-none" />

          <div className="relative z-10 flex flex-col items-center gap-2 mb-10">
            <div className="flex items-center gap-2.5">
              <span className="text-2xl">👁</span>
              <h1 className="text-3xl font-bold tracking-tight">CogniView</h1>
            </div>
            <p className="text-gray-400 text-sm">AI that actually watches your screen</p>
          </div>

          <div className="relative z-10">
            <ScreenCapture
              isCapturing={isCapturing}
              isAnalyzing={isAnalyzing}
              isTranscribing={activeTranscriptJobs > 0}
              hasCompletedMeeting={!isCapturing && hasMeetingData}
              isGeneratingSummary={isGeneratingFinalSummary}
              captureError={captureError}
              analysisError={analysisError}
              transcriptError={transcriptError}
              onStart={handleStart}
              onStop={handleStop}
            />
          </div>

          {showMainScreenSummary && (
            <div className="relative z-10 mt-8 w-full max-w-4xl">
              <FinalSummaryCard
                variant="main"
                summary={finalSummary}
                summaryError={finalSummaryError}
                isGeneratingSummary={isGeneratingFinalSummary}
                isCapturing={isCapturing}
                hasMeetingData={hasMeetingData}
                onGenerateSummary={requestFinalSummary}
              />
            </div>
          )}

          {isCapturing && (
            <div className="relative z-10 mt-10 flex gap-6 text-center">
              {[
                { label: 'Frames analyzed', value: insights.length },
                { label: 'Transcripts', value: transcriptSegments.length },
                { label: 'Action items', value: allActionItems.length },
                { label: 'Messages', value: assistantChatMessageCount },
              ].map(({ label, value }) => (
                <div key={label} className="flex flex-col gap-0.5">
                  <span className="text-2xl font-bold text-indigo-300">{value}</span>
                  <span className="text-xs text-gray-500">{label}</span>
                </div>
              ))}
            </div>
          )}

          <div className="absolute bottom-6 flex items-center gap-3 text-xs text-gray-600">
            <span>Powered by</span>
            <span className="text-gray-500">Gemini Vision</span>
            <span>+</span>
            <span className="text-gray-500">Claude AI</span>
            <span>+</span>
            <span className="text-gray-500">Assistant UI</span>
          </div>
        </div>

        {isSidebarDetached ? (
          <div className="w-80 border-l border-gray-800 bg-gray-900 flex flex-col justify-between">
            <div className="p-5 space-y-4">
              <div className="space-y-2">
                <p className="text-sm font-semibold text-gray-100">
                  {detachedSidebarMode === 'pip'
                    ? 'Copilot is floating over your work'
                    : 'Copilot is popped out'}
                </p>
                <p className="text-sm text-gray-400 leading-relaxed">
                  {detachedSidebarMode === 'pip'
                    ? 'Keep this tab open while you present. The live sidebar is running in a small always-on-top companion window so it stays visible after you switch to the window you chose to share.'
                    : 'Keep this tab open while you present. Your live sidebar is updating in its own window so it stays visible when this page is in the background.'}
                </p>
              </div>

              <div className="grid gap-2">
                {detachedSidebarMode === 'popup' && (
                  <Button
                    onClick={focusSidebarWindow}
                    className="bg-indigo-600 hover:bg-indigo-500 text-white"
                  >
                    Focus Copilot Window
                  </Button>
                )}
                <Button
                  onClick={closeSidebarWindow}
                  variant={detachedSidebarMode === 'popup' ? 'outline' : 'default'}
                  className={
                    detachedSidebarMode === 'popup'
                      ? 'border-gray-700 bg-gray-950 text-gray-200 hover:bg-gray-800'
                      : 'bg-indigo-600 hover:bg-indigo-500 text-white'
                  }
                >
                  Dock Sidebar Back Here
                </Button>
              </div>
            </div>

            <div className="px-5 pb-5 text-xs text-gray-500 leading-relaxed">
              {detachedSidebarMode === 'pip'
                ? 'If you close the floating companion window, the sidebar will return here automatically.'
                : 'If you close the pop-out window, the sidebar will return here automatically.'}
            </div>
          </div>
        ) : (
          <CopilotSidebar {...sidebarProps} />
        )}
      </div>

      {detachedSidebarContainer &&
        createPortal(
          <div className="h-screen bg-gray-950 text-white">
            <CopilotSidebar {...sidebarProps} />
          </div>,
          detachedSidebarContainer
        )}
    </>
  );
}
