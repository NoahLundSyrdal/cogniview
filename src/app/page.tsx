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
import type { FactCheckResult, FactCheckStatement, FrameAnalysis } from '@/types';

const TRANSCRIPT_ACTION_INTERVAL_MS = 15000;
const TRANSCRIPT_ACTION_MAX_CHARS = 2000;
const BACKGROUND_FACTCHECK_DEBOUNCE_MS = 800;
const BACKGROUND_FACTCHECK_MAX_CLAIMS = 1;
const FACTCHECK_HISTORY_LIMIT = 6;

const DUPLICATE_INSIGHT_SUMMARY_THRESHOLD = 0.58;
const DUPLICATE_INSIGHT_LIST_THRESHOLD = 0.5;
const DUPLICATE_INSIGHT_COMBINED_THRESHOLD = 0.64;
const DUPLICATE_INSIGHT_MEDIUM_THRESHOLD = 0.42;
const DUPLICATE_INSIGHT_WINDOW_MS = 45000;
const DUPLICATE_INSIGHT_RECENT_LIMIT = 6;
const DUPLICATE_INSIGHT_TOPIC_LIMIT = 18;
const DUPLICATE_INSIGHT_SIGNATURE_THRESHOLD = 0.55;
const DUPLICATE_INSIGHT_SUMMARY_TOPIC_THRESHOLD = 0.52;
const DUPLICATE_INSIGHT_PREFIX_WORDS = 14;
const DUPLICATE_INSIGHT_NOVELTY_THRESHOLD = 0.24;
const VOICE_INSIGHT_MIN_CHARS = 36;
const VOICE_INSIGHT_MIN_WORDS = 7;
const VOICE_INSIGHT_MAX_SUMMARY_CHARS = 420;
const VOICE_INSIGHT_MIN_ALPHA_RATIO = 0.65;
const VOICE_INSIGHT_FILLER_RATIO_LIMIT = 0.45;
const VOICE_INSIGHT_COOLDOWN_MS = 10000;
const VOICE_INSIGHT_HIGH_NOVELTY_THRESHOLD = 0.52;
const VOICE_INSIGHT_DUPLICATE_LOOKBACK = 8;
const VOICE_INSIGHT_MIN_CONTENT_SCORE = 2;
const VOICE_BUFFER_MIN_CHARS = 500;
const VOICE_BUFFER_MAX_CHARS = 900;
const VOICE_BUFFER_FLUSH_INTERVAL_MS = 60000;
const DOMAIN_RE = /\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi;
const QUOTED_TEXT_RE = /["'“”‘’]([^"'“”‘’]{8,160})["'“”‘’]/g;
const NON_ALPHA_RE = /[^a-z\s]/gi;
const NUMBER_TOKEN_RE = /\b\d[\d,./-]*\b/;
const ACTION_CUE_RE =
  /\b(need to|needs to|must|should|please|make sure|follow up|action item|next step|send|submit|review|prepare|schedule|assign|update|share|deliver)\b/i;
const DECISION_CUE_RE =
  /\b(decided|decision|agreed|approved|plan is|we will|deadline|owner|by (monday|tuesday|wednesday|thursday|friday|saturday|sunday)|today|tomorrow)\b/i;
const SMALLTALK_RE =
  /\b(hello|hi|hey|how are you|thanks|thank you|good morning|good afternoon|good evening|bye|see you)\b/i;
const FILLER_TOKEN_SET = new Set([
  'uh',
  'um',
  'hmm',
  'mm',
  'mmm',
  'ah',
  'er',
  'like',
  'you',
  'know',
  'sorta',
  'kinda',
]);
const INFORMATIVE_TOKEN_SET = new Set([
  'deadline',
  'deliverable',
  'requirement',
  'risk',
  'issue',
  'blocker',
  'status',
  'update',
  'decision',
  'owner',
  'project',
  'report',
  'result',
  'finding',
  'budget',
  'scope',
  'milestone',
  'roadmap',
  'customer',
  'contract',
  'invoice',
  'release',
  'deploy',
  'fix',
  'bug',
  'test',
  'action',
]);

function normalizeStringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
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

function toWordPrefix(text: string, maxWords = DUPLICATE_INSIGHT_PREFIX_WORDS) {
  return normalizeInsightText(text)
    .split(' ')
    .filter(Boolean)
    .slice(0, maxWords)
    .join(' ');
}

function toFirstSentence(text: string) {
  const sentence = text.split(/[.!?]/)[0] || '';
  return normalizeInsightText(sentence);
}

function hasRepeatedSummaryLead(previousSummary: string, nextSummary: string) {
  const previousSentence = toFirstSentence(previousSummary);
  const nextSentence = toFirstSentence(nextSummary);
  if (previousSentence && nextSentence) {
    if (previousSentence === nextSentence) return true;
    if (previousSentence.includes(nextSentence) || nextSentence.includes(previousSentence)) {
      const minLength = Math.min(previousSentence.length, nextSentence.length);
      if (minLength >= 20) return true;
    }
  }

  const previousPrefix = toWordPrefix(previousSummary);
  const nextPrefix = toWordPrefix(nextSummary);
  if (!previousPrefix || !nextPrefix) return false;
  if (previousPrefix === nextPrefix) return true;
  return previousPrefix.includes(nextPrefix) || nextPrefix.includes(previousPrefix);
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

function signatureSimilarity(left: string | undefined, right: string | undefined) {
  const leftTokens = tokenizeInsightText(left || '');
  const rightTokens = tokenizeInsightText(right || '');
  if (!leftTokens.length || !rightTokens.length) return 0;
  return jaccardSimilarity(leftTokens, rightTokens);
}

function isSameInsightTopic(previous: FrameAnalysis, next: FrameAnalysis) {
  if (previous.screenType !== next.screenType) return false;

  const signatureScore = signatureSimilarity(previous.sceneSignature, next.sceneSignature);
  if (signatureScore >= DUPLICATE_INSIGHT_SIGNATURE_THRESHOLD) {
    return true;
  }

  const summaryScore = jaccardSimilarity(
    tokenizeInsightText(previous.summary),
    tokenizeInsightText(next.summary)
  );
  return summaryScore >= DUPLICATE_INSIGHT_SUMMARY_TOPIC_THRESHOLD;
}

function summaryNoveltyScore(nextSummary: string, previousInsights: FrameAnalysis[]) {
  const nextTokens = new Set(tokenizeInsightText(nextSummary));
  if (nextTokens.size === 0) return 0;

  const previousTokenSet = new Set<string>();
  for (const insight of previousInsights) {
    for (const token of tokenizeInsightText(insight.summary)) {
      previousTokenSet.add(token);
    }
  }

  let novelTokens = 0;
  for (const token of nextTokens) {
    if (!previousTokenSet.has(token)) {
      novelTokens += 1;
    }
  }

  return novelTokens / nextTokens.size;
}

function buildPreviousInsightContext(insight: FrameAnalysis | null) {
  if (!insight) return '';

  const signature = insight.sceneSignature?.trim() || 'none';
  return [
    'Latest accepted insight:',
    `- Previous sceneSignature: ${signature}`,
    `- Previous summary: ${insight.summary}`,
  ].join('\n');
}

function getLatestVisionInsight(insights: FrameAnalysis[]) {
  for (let index = insights.length - 1; index >= 0; index -= 1) {
    const insight = insights[index];
    if (insight.source !== 'voice' && insight.screenType !== 'voice') {
      return insight;
    }
  }
  return null;
}

function countWordTokens(text: string) {
  return normalizeInsightText(text).split(' ').filter(Boolean);
}

function hasExcessiveRepeatedWordRun(tokens: string[]) {
  if (tokens.length < 5) return false;
  let run = 1;
  for (let index = 1; index < tokens.length; index += 1) {
    if (tokens[index] === tokens[index - 1]) {
      run += 1;
      if (run >= 4) return true;
    } else {
      run = 1;
    }
  }
  return false;
}

function alphaRatio(text: string) {
  const normalized = text.toLowerCase();
  const withoutSpaces = normalized.replace(/\s+/g, '');
  if (!withoutSpaces.length) return 0;
  const alphaChars = withoutSpaces.replace(NON_ALPHA_RE, '').length;
  return alphaChars / withoutSpaces.length;
}

function fillerRatio(tokens: string[]) {
  if (!tokens.length) return 1;
  let filler = 0;
  for (const token of tokens) {
    if (FILLER_TOKEN_SET.has(token)) filler += 1;
  }
  return filler / tokens.length;
}

function informativeTokenCount(tokens: string[]) {
  let count = 0;
  for (const token of tokens) {
    if (INFORMATIVE_TOKEN_SET.has(token)) {
      count += 1;
    }
  }
  return count;
}

function voiceContentScore(clean: string, tokens: string[]) {
  let score = 0;

  if (NUMBER_TOKEN_RE.test(clean)) score += 1;
  if (ACTION_CUE_RE.test(clean)) score += 2;
  if (DECISION_CUE_RE.test(clean)) score += 2;
  if (informativeTokenCount(tokens) >= 2) score += 1;

  return score;
}

function isConservativeVoiceTranscript(text: string) {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length < VOICE_INSIGHT_MIN_CHARS) return false;

  const tokens = countWordTokens(clean);
  if (tokens.length < VOICE_INSIGHT_MIN_WORDS) return false;
  if (hasExcessiveRepeatedWordRun(tokens)) return false;
  if (alphaRatio(clean) < VOICE_INSIGHT_MIN_ALPHA_RATIO) return false;
  if (fillerRatio(tokens) > VOICE_INSIGHT_FILLER_RATIO_LIMIT) return false;
  if (SMALLTALK_RE.test(clean) && !ACTION_CUE_RE.test(clean) && !DECISION_CUE_RE.test(clean)) {
    return false;
  }
  if (voiceContentScore(clean, tokens) < VOICE_INSIGHT_MIN_CONTENT_SCORE) return false;

  return true;
}

function summarizeVoiceTranscript(text: string) {
  const clean = text.replace(/\s+/g, ' ').trim();
  const sentences = clean
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

  const useful = sentences.filter((sentence) => {
    const tokens = countWordTokens(sentence);
    if (!tokens.length) return false;
    if (SMALLTALK_RE.test(sentence) && !ACTION_CUE_RE.test(sentence) && !DECISION_CUE_RE.test(sentence)) {
      return false;
    }
    return voiceContentScore(sentence, tokens) >= VOICE_INSIGHT_MIN_CONTENT_SCORE;
  });

  const picked = (useful.length > 0 ? useful : sentences).slice(0, 3);
  const summary = picked.join(' ').replace(/\s+/g, ' ').trim();
  return summary.slice(0, VOICE_INSIGHT_MAX_SUMMARY_CHARS);
}

function buildVoiceSceneSignature(summary: string) {
  return `voice ${toWordPrefix(summary, 8)}`.trim();
}

function appendBufferedVoiceText(existing: string, incoming: string) {
  const normalizedExisting = existing.replace(/\s+/g, ' ').trim();
  const normalizedIncoming = incoming.replace(/\s+/g, ' ').trim();
  if (!normalizedIncoming) return normalizedExisting;
  if (!normalizedExisting) return normalizedIncoming;
  if (normalizedExisting === normalizedIncoming) return normalizedExisting;
  if (normalizedExisting.endsWith(normalizedIncoming)) return normalizedExisting;
  if (normalizedIncoming.startsWith(normalizedExisting)) return normalizedIncoming;
  return `${normalizedExisting} ${normalizedIncoming}`.replace(/\s+/g, ' ').trim();
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

type FactCheckSnapshot = {
  key: string;
  frame: string;
  transcriptContext: string;
  mode: 'background' | 'interactive';
  claims: string[];
  statements: FactCheckStatement[];
  results: FactCheckResult[];
  timestamp: number;
};

function hashFactCheckInput(frame: string, transcriptContext: string) {
  const input = `${frame}\u241f${transcriptContext}`;
  let hash = 2166136261;

  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(16);
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
  const [activeBackgroundFactCheckJobs, setActiveBackgroundFactCheckJobs] = useState(0);
  const [factCheckError, setFactCheckError] = useState<string | null>(null);
  const [factCheckStatus, setFactCheckStatus] = useState<string | null>(null);
  const [factCheckClaims, setFactCheckClaims] = useState<string[]>([]);
  const [factCheckStatements, setFactCheckStatements] = useState<FactCheckStatement[]>([]);
  const [factCheckResults, setFactCheckResults] = useState<FactCheckResult[]>([]);
  const [insightStats, setInsightStats] = useState({ accepted: 0, deduped: 0 });
  const insightsRef = useRef<FrameAnalysis[]>([]);
  const latestAnalysisRef = useRef<FrameAnalysis | null>(null);
  const transcriptQueueRef = useRef<Promise<void>>(Promise.resolve());
  const transcriptActionQueueRef = useRef<Promise<void>>(Promise.resolve());
  const lastTranscriptActionRunAtRef = useRef(0);
  const lastTranscriptActionInputRef = useRef('');
  const latestTranscriptContextRef = useRef('');
  const lastVoiceInsightAtRef = useRef(0);
  const lastVoiceInsightSummaryRef = useRef('');
  const voiceTranscriptBufferRef = useRef('');
  const lastVoiceBufferedDigestRef = useRef('');
  const voiceLastFlushAtRef = useRef(0);
  const voiceFlushTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestFrameRef = useRef<string | null>(null);
  const lastFactCheckedKeyRef = useRef<string | null>(null);
  const pendingFactCheckFrameRef = useRef<string | null>(null);
  const isFactCheckingRef = useRef(false);
  const isCapturingRef = useRef(false);
  const backgroundFactCheckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const backgroundFactCheckKeyRef = useRef<string | null>(null);
  const backgroundFactCheckPromiseRef = useRef<Promise<FactCheckSnapshot | null> | null>(null);
  const cachedFactCheckSnapshotRef = useRef<FactCheckSnapshot | null>(null);
  const factCheckHistoryRef = useRef<FactCheckSnapshot[]>([]);
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
    addMeetingSignals,
    addTranscriptSegment,
    getTranscriptSummary,
    getScreenSummary,
    getContextSummary,
    reset,
  } = useMeetingContext();
  const hasMeetingData = insights.length > 0 || transcriptSegments.length > 0;

  useEffect(() => {
    insightsRef.current = insights;
  }, [insights]);

  useEffect(() => {
    latestTranscriptContextRef.current = getTranscriptSummary();
  }, [getTranscriptSummary, transcriptSegments]);

  useEffect(() => {
    if (process.env.NODE_ENV !== 'development') return;
    console.debug(
      '[insights] accepted=%d deduped=%d',
      insightStats.accepted,
      insightStats.deduped
    );
  }, [getTranscriptSummary, insightStats.accepted, insightStats.deduped, transcriptSegments]);

  const generateFinalSummary = useCallback(
    async (sessionId: number) => {
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
            factCheckRuns: factCheckHistoryRef.current.map((item) => ({
              timestamp: item.timestamp,
              claims: item.claims,
              statements: item.statements,
              results: item.results,
            })),
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
    },
    [allActionItems, hasMeetingData, insights, startTime, transcriptSegments]
  );

  const requestFinalSummary = useCallback(() => {
    if (!hasMeetingData) return;
    setFinalSummary(null);
    setFinalSummaryError(null);
    setIsGeneratingFinalSummary(true);
    setShouldGenerateFinalSummary(true);
  }, [hasMeetingData]);

  const buildFactCheckRequest = useCallback(
    (
      frame: string,
      options: {
        maxClaims?: number;
        mode?: 'background' | 'interactive';
      } = {}
    ) => {
      const transcriptContext = getTranscriptSummary();
      const payload = {
        frame,
        meetingContext: getContextSummary(),
        screenContext: getScreenSummary(),
        transcriptContext,
        mode: options.mode ?? 'interactive',
        ...(typeof options.maxClaims === 'number' ? { maxClaims: options.maxClaims } : {}),
      };

      return {
        key: hashFactCheckInput(frame, transcriptContext),
        payload,
      };
    },
    [getContextSummary, getScreenSummary, getTranscriptSummary]
  );

  const storeFactCheckSnapshot = useCallback((snapshot: FactCheckSnapshot) => {
    const existingSnapshot = factCheckHistoryRef.current.find((item) => item.key === snapshot.key);
    if (existingSnapshot?.mode === 'interactive' && snapshot.mode === 'background') {
      cachedFactCheckSnapshotRef.current = existingSnapshot;
      return;
    }

    cachedFactCheckSnapshotRef.current = snapshot;
    factCheckHistoryRef.current = [
      snapshot,
      ...factCheckHistoryRef.current.filter((item) => item.key !== snapshot.key),
    ].slice(0, FACTCHECK_HISTORY_LIMIT);
  }, []);

  const applyFactCheckSnapshot = useCallback(
    (
      snapshot: FactCheckSnapshot,
      options: {
        status?: string | null;
        markAsChecked?: boolean;
      } = {}
    ) => {
      setFactCheckError(null);
      setFactCheckClaims(snapshot.claims);
      setFactCheckStatements(snapshot.statements);
      setFactCheckResults(snapshot.results);
      setFactCheckStatus(options.status ?? null);

      if (options.markAsChecked !== false) {
        lastFactCheckedKeyRef.current = snapshot.key;
      }
    },
    []
  );

  const executeFactCheck = useCallback(
    async ({
      frame,
      background = false,
      maxClaims,
      keepExistingResults = false,
      statusMessage,
    }: {
      frame: string;
      background?: boolean;
      maxClaims?: number;
      keepExistingResults?: boolean;
      statusMessage?: string | null;
    }): Promise<FactCheckSnapshot | null> => {
      const { key, payload } = buildFactCheckRequest(frame, {
        maxClaims,
        mode: background ? 'background' : 'interactive',
      });
      let task: Promise<FactCheckSnapshot | null> | null = null;

      if (background) {
        backgroundFactCheckKeyRef.current = key;
        setActiveBackgroundFactCheckJobs((count) => count + 1);
      } else {
        pendingFactCheckFrameRef.current = null;
        setFactCheckStatus(statusMessage ?? null);
        setFactCheckError(null);
        if (!keepExistingResults) {
          setFactCheckClaims([]);
          setFactCheckStatements([]);
          setFactCheckResults([]);
        }
        setIsFactChecking(true);
        isFactCheckingRef.current = true;
      }

      task = (async () => {
        try {
          const res = await fetch('/api/fact-check', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          const data = await res.json();
          if (!res.ok) {
            if (!background) {
              setFactCheckError(data.error || 'Fact-check failed');
            }
            return null;
          }

          const snapshot: FactCheckSnapshot = {
            key,
            frame,
            transcriptContext: payload.transcriptContext,
            mode: payload.mode,
            claims: Array.isArray(data.claims) ? data.claims : [],
            statements: Array.isArray(data.statements) ? data.statements : [],
            results: Array.isArray(data.results) ? data.results : [],
            timestamp: Date.now(),
          };

          storeFactCheckSnapshot(snapshot);

          const currentKey = latestFrameRef.current
            ? hashFactCheckInput(latestFrameRef.current, latestTranscriptContextRef.current)
            : null;

          if (!background || currentKey === snapshot.key) {
            applyFactCheckSnapshot(snapshot, {
              status: background
                ? snapshot.results.length > 0 || snapshot.claims.length > 0
                  ? 'Background fact-check is ready for the current screen and recent speech.'
                  : 'Background fact-check did not find a high-priority claim yet.'
                : null,
            });
          }

          return snapshot;
        } catch (err) {
          console.error(background ? 'Background fact-check failed:' : 'Fact-check failed:', err);
          if (!background) {
            setFactCheckError('Network error. Please try again.');
          }
          return null;
        } finally {
          if (background) {
            setActiveBackgroundFactCheckJobs((count) => Math.max(0, count - 1));
            if (backgroundFactCheckKeyRef.current === key) {
              backgroundFactCheckKeyRef.current = null;
            }
            if (task && backgroundFactCheckPromiseRef.current === task) {
              backgroundFactCheckPromiseRef.current = null;
            }
          } else {
            setIsFactChecking(false);
            isFactCheckingRef.current = false;
          }
        }
      })();

      if (background && task) {
        backgroundFactCheckPromiseRef.current = task;
      }

      return task;
    },
    [applyFactCheckSnapshot, buildFactCheckRequest, storeFactCheckSnapshot]
  );

  const scheduleBackgroundFactCheck = useCallback(() => {
    if (!isCapturingRef.current || isFactCheckingRef.current) return;
    if (backgroundFactCheckTimerRef.current) {
      clearTimeout(backgroundFactCheckTimerRef.current);
    }

    backgroundFactCheckTimerRef.current = setTimeout(() => {
      backgroundFactCheckTimerRef.current = null;
      const frame = latestFrameRef.current;
      if (!frame || isFactCheckingRef.current) return;

      const { key } = buildFactCheckRequest(frame, {
        maxClaims: BACKGROUND_FACTCHECK_MAX_CLAIMS,
        mode: 'background',
      });
      if (cachedFactCheckSnapshotRef.current?.key === key) return;
      if (backgroundFactCheckKeyRef.current === key) return;

      void executeFactCheck({
        frame,
        background: true,
        maxClaims: BACKGROUND_FACTCHECK_MAX_CLAIMS,
      });
    }, BACKGROUND_FACTCHECK_DEBOUNCE_MS);
  }, [buildFactCheckRequest, executeFactCheck]);
  const acceptInsightCandidate = useCallback(
    (analysis: FrameAnalysis, options?: { setAsLatestScreenAnalysis?: boolean }) => {
      const recentInsights = insightsRef.current
        .filter((item) => analysis.timestamp - item.timestamp <= DUPLICATE_INSIGHT_WINDOW_MS)
        .slice(-DUPLICATE_INSIGHT_TOPIC_LIMIT);
      const topicInsights = recentInsights.filter((item) => isSameInsightTopic(item, analysis));
      const duplicateCandidates =
        topicInsights.length > 0
          ? topicInsights
          : recentInsights.slice(-DUPLICATE_INSIGHT_RECENT_LIMIT);
      if (duplicateCandidates.some((item) => hasRepeatedSummaryLead(item.summary, analysis.summary))) {
        setInsightStats((prev) => ({ ...prev, deduped: prev.deduped + 1 }));
        return false;
      }
      const noveltyScore = summaryNoveltyScore(analysis.summary, duplicateCandidates);
      if (
        duplicateCandidates.length > 0 &&
        noveltyScore < DUPLICATE_INSIGHT_NOVELTY_THRESHOLD &&
        analysis.actionItems.length === 0 &&
        analysis.factCheckFlags.length === 0
      ) {
        setInsightStats((prev) => ({ ...prev, deduped: prev.deduped + 1 }));
        return false;
      }
      if (duplicateCandidates.some((item) => isNearDuplicateInsight(item, analysis))) {
        setInsightStats((prev) => ({ ...prev, deduped: prev.deduped + 1 }));
        return false;
      }

      addInsight(analysis);
      if (options?.setAsLatestScreenAnalysis) {
        latestAnalysisRef.current = analysis;
      }
      setInsightStats((prev) => ({ ...prev, accepted: prev.accepted + 1 }));
      return true;
    },
    [addInsight]
  );

  const flushVoiceBuffer = useCallback(
    (reason: 'size' | 'time' | 'stop' = 'time') => {
      if (voiceFlushTimeoutRef.current) {
        clearTimeout(voiceFlushTimeoutRef.current);
        voiceFlushTimeoutRef.current = null;
      }

      const bufferedText = voiceTranscriptBufferRef.current.replace(/\s+/g, ' ').trim();
      if (!bufferedText) return false;

      const minChars = reason === 'stop' ? VOICE_INSIGHT_MIN_CHARS : VOICE_BUFFER_MIN_CHARS;
      if (bufferedText.length < minChars) {
        return false;
      }

      const digest = normalizeInsightText(bufferedText);
      if (digest && digest === lastVoiceBufferedDigestRef.current) {
        voiceTranscriptBufferRef.current = '';
        voiceLastFlushAtRef.current = Date.now();
        return false;
      }
      lastVoiceBufferedDigestRef.current = digest;
      voiceTranscriptBufferRef.current = '';
      voiceLastFlushAtRef.current = Date.now();

      if (!isConservativeVoiceTranscript(bufferedText)) {
        return false;
      }

      const voiceSummary = summarizeVoiceTranscript(bufferedText);
      if (!voiceSummary) {
        return false;
      }

      if (
        lastVoiceInsightSummaryRef.current &&
        hasRepeatedSummaryLead(lastVoiceInsightSummaryRef.current, voiceSummary)
      ) {
        return false;
      }

      const now = Date.now();
      const recentVoiceInsights = insightsRef.current
        .filter((insight) => insight.source === 'voice' || insight.screenType === 'voice')
        .slice(-VOICE_INSIGHT_DUPLICATE_LOOKBACK);
      const voiceNovelty = summaryNoveltyScore(voiceSummary, recentVoiceInsights);

      if (
        now - lastVoiceInsightAtRef.current < VOICE_INSIGHT_COOLDOWN_MS &&
        voiceNovelty < VOICE_INSIGHT_HIGH_NOVELTY_THRESHOLD
      ) {
        return false;
      }

      const voiceInsight: FrameAnalysis = {
        screenType: 'voice',
        source: 'voice',
        summary: voiceSummary,
        keyPoints: [],
        suggestedQuestions: [],
        actionItems: [],
        factCheckFlags: [],
        sceneSignature: buildVoiceSceneSignature(voiceSummary),
        contextForNext: context,
        timestamp: now,
      };

      if (acceptInsightCandidate(voiceInsight)) {
        lastVoiceInsightAtRef.current = now;
        lastVoiceInsightSummaryRef.current = voiceSummary;
        return true;
      }

      return false;
    },
    [acceptInsightCandidate, context]
  );

  const scheduleVoiceBufferFlush = useCallback(() => {
    if (voiceFlushTimeoutRef.current) return;
    if (!voiceTranscriptBufferRef.current.trim()) return;

    const elapsed = Date.now() - voiceLastFlushAtRef.current;
    const delay = Math.max(1000, VOICE_BUFFER_FLUSH_INTERVAL_MS - elapsed);
    voiceFlushTimeoutRef.current = setTimeout(() => {
      voiceFlushTimeoutRef.current = null;
      flushVoiceBuffer('time');
    }, delay);
  }, [flushVoiceBuffer]);

  const handleFrame = useCallback(
    async (frame: string) => {
      latestFrameRef.current = frame;
      scheduleBackgroundFactCheck();
      if (
        pendingFactCheckFrameRef.current &&
        frame !== pendingFactCheckFrameRef.current &&
        !isFactCheckingRef.current
      ) {
        void executeFactCheck({ frame });
      }
      setIsAnalyzing(true);
      setAnalysisError(null);
      const transcriptSummary = getTranscriptSummary();
      const previousInsightContext = buildPreviousInsightContext(
        getLatestVisionInsight(insightsRef.current)
      );

      try {
        const res = await fetch('/api/analyze-frame', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            frame,
            previousContext: [
              context,
              previousInsightContext,
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
            source: 'vision',
            sceneSignature:
              typeof data.sceneSignature === 'string' ? data.sceneSignature.trim() : '',
            timestamp: Date.now(),
          };
          acceptInsightCandidate(analysis, { setAsLatestScreenAnalysis: true });
        }
      } catch (err) {
        setAnalysisError('Network error — check your connection.');
        console.error('Frame analysis failed:', err);
      }
      setIsAnalyzing(false);
    },
    [acceptInsightCandidate, context, executeFactCheck, getTranscriptSummary, scheduleBackgroundFactCheck]
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

            const transcriptText = typeof data.text === 'string' ? data.text.trim() : '';
            if (transcriptText) {
              addTranscriptSegment({ text: transcriptText });
              voiceTranscriptBufferRef.current = appendBufferedVoiceText(
                voiceTranscriptBufferRef.current,
                transcriptText
              );

              const now = Date.now();
              const shouldFlushBySize = voiceTranscriptBufferRef.current.length >= VOICE_BUFFER_MAX_CHARS;
              const shouldFlushByTime =
                now - voiceLastFlushAtRef.current >= VOICE_BUFFER_FLUSH_INTERVAL_MS &&
                voiceTranscriptBufferRef.current.length >= VOICE_BUFFER_MIN_CHARS;

              if (shouldFlushBySize || shouldFlushByTime) {
                flushVoiceBuffer(shouldFlushBySize ? 'size' : 'time');
              } else {
                scheduleVoiceBufferFlush();
              }
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
    [addTranscriptSegment, flushVoiceBuffer, scheduleVoiceBufferFlush]
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
          addMeetingSignals({
            actionItems: normalizeStringArray(data.actionItems),
            decisions: normalizeStringArray(data.decisions),
            openQuestions: normalizeStringArray(data.openQuestions),
          });
        } catch (err) {
          console.error('Transcript commitment extraction failed:', err);
        } finally {
          setActiveTranscriptActionJobs((count) => Math.max(0, count - 1));
        }
      });

    await transcriptActionQueueRef.current;
  }, [addMeetingSignals, getContextSummary, getTranscriptSummary]);

  const { isCapturing, captureError, startCapture, stopCapture } = useScreenCapture({
    onFrame: handleFrame,
    onAudioChunk: handleAudioChunk,
  });

  useEffect(() => {
    isCapturingRef.current = isCapturing;
  }, [isCapturing]);

  const showMainScreenSummary =
    !isCapturing &&
    hasMeetingData &&
    (isGeneratingFinalSummary || Boolean(finalSummary) || Boolean(finalSummaryError));

  useEffect(() => {
    if (!shouldGenerateFinalSummary) return;
    if (
      isCapturing ||
      isAnalyzing ||
      activeTranscriptJobs > 0 ||
      activeTranscriptActionJobs > 0 ||
      activeBackgroundFactCheckJobs > 0
    ) {
      return;
    }

    const sessionId = meetingSessionIdRef.current;
    setShouldGenerateFinalSummary(false);
    void generateFinalSummary(sessionId);
  }, [
    activeBackgroundFactCheckJobs,
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

  useEffect(() => {
    if (!isCapturing || !latestFrameRef.current) return;
    scheduleBackgroundFactCheck();
  }, [isCapturing, scheduleBackgroundFactCheck, transcriptSegments]);

  useEffect(
    () => () => {
      if (voiceFlushTimeoutRef.current) {
        clearTimeout(voiceFlushTimeoutRef.current);
        voiceFlushTimeoutRef.current = null;
      }
    },
    []
  );

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
    setActiveBackgroundFactCheckJobs(0);
    transcriptQueueRef.current = Promise.resolve();
    transcriptActionQueueRef.current = Promise.resolve();
    lastTranscriptActionRunAtRef.current = 0;
    lastTranscriptActionInputRef.current = '';
    latestTranscriptContextRef.current = '';
    lastVoiceInsightAtRef.current = 0;
    lastVoiceInsightSummaryRef.current = '';
    voiceTranscriptBufferRef.current = '';
    lastVoiceBufferedDigestRef.current = '';
    voiceLastFlushAtRef.current = Date.now();
    if (voiceFlushTimeoutRef.current) {
      clearTimeout(voiceFlushTimeoutRef.current);
      voiceFlushTimeoutRef.current = null;
    }
    latestFrameRef.current = null;
    latestAnalysisRef.current = null;
    setFactCheckError(null);
    setFactCheckStatus(null);
    setFactCheckClaims([]);
    setFactCheckStatements([]);
    setFactCheckResults([]);
    if (backgroundFactCheckTimerRef.current) {
      clearTimeout(backgroundFactCheckTimerRef.current);
      backgroundFactCheckTimerRef.current = null;
    }
    backgroundFactCheckKeyRef.current = null;
    backgroundFactCheckPromiseRef.current = null;
    cachedFactCheckSnapshotRef.current = null;
    factCheckHistoryRef.current = [];
    lastFactCheckedKeyRef.current = null;
    setInsightStats({ accepted: 0, deduped: 0 });
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

  const handleStop = useCallback(async () => {
    flushVoiceBuffer('stop');
    pendingFactCheckFrameRef.current = null;
    setFactCheckStatus(null);
    await stopCapture();
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
    if (backgroundFactCheckTimerRef.current) {
      clearTimeout(backgroundFactCheckTimerRef.current);
      backgroundFactCheckTimerRef.current = null;
    }
    const latestFrame = latestFrameRef.current;
    if (latestFrame) {
      const { key } = buildFactCheckRequest(latestFrame, {
        maxClaims: BACKGROUND_FACTCHECK_MAX_CLAIMS,
        mode: 'background',
      });
      if (backgroundFactCheckKeyRef.current === key && backgroundFactCheckPromiseRef.current) {
        await backgroundFactCheckPromiseRef.current;
      } else if (cachedFactCheckSnapshotRef.current?.key !== key) {
        await executeFactCheck({
          frame: latestFrame,
          background: true,
          maxClaims: BACKGROUND_FACTCHECK_MAX_CLAIMS,
        });
      }
    }
    requestFinalSummary();
  }, [buildFactCheckRequest, executeFactCheck, flushVoiceBuffer, requestFinalSummary, stopCapture]);

  const handleRunFactCheck = useCallback(async () => {
    const latestFrame = latestFrameRef.current;
    if (!latestFrame) {
      setFactCheckError('No captured frame available yet.');
      setFactCheckStatus(null);
      return;
    }

    const { key } = buildFactCheckRequest(latestFrame);
    const cachedSnapshot = cachedFactCheckSnapshotRef.current;

    if (cachedSnapshot?.key === key) {
      applyFactCheckSnapshot(cachedSnapshot, {
        status:
          cachedSnapshot.mode === 'background'
            ? 'Showing the background fact-check already prepared for the current screen.'
            : 'Showing the latest fact-check already prepared for the current screen.',
      });
      if (cachedSnapshot.mode === 'background') {
        void executeFactCheck({
          frame: latestFrame,
          keepExistingResults: true,
          statusMessage: 'Deepening the background fact-check with more evidence...',
        });
      }
      return;
    }

    if (backgroundFactCheckKeyRef.current === key && backgroundFactCheckPromiseRef.current) {
      setFactCheckError(null);
      setFactCheckStatus('Background fact-check is already running for the current screen.');
      setIsFactChecking(true);
      isFactCheckingRef.current = true;
      try {
        const snapshot = await backgroundFactCheckPromiseRef.current;
        if (snapshot?.key === key) {
          applyFactCheckSnapshot(snapshot, {
            status: 'Background fact-check finished for the current screen.',
          });
        }
      } finally {
        setIsFactChecking(false);
        isFactCheckingRef.current = false;
      }
      return;
    }

    if (key === lastFactCheckedKeyRef.current) {
      pendingFactCheckFrameRef.current = latestFrame;
      setFactCheckError(null);
      setFactCheckStatus(
        'The current screen and recent speech are unchanged. Waiting for new screen content or a new spoken claim before rerunning fact-check.'
      );
      return;
    }

    await executeFactCheck({ frame: latestFrame });
  }, [applyFactCheckSnapshot, buildFactCheckRequest, executeFactCheck]);

  const sidebarProps = {
    insights,
    chatMessageCount: assistantChatMessageCount,
    isCapturing,
    isAnalyzing: isAnalyzing || activeTranscriptJobs > 0,
    isTranscribing: activeTranscriptJobs > 0,
    transcriptSegments,
    finalSummary,
    finalSummaryError,
    isGeneratingSummary: isGeneratingFinalSummary,
    onGenerateSummary: requestFinalSummary,
    factCheckClaims,
    factCheckStatements,
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
                { label: 'Chat messages', value: assistantChatMessageCount },
                { label: 'Fact-check results', value: factCheckResults.length },
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
