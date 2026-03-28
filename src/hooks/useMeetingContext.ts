'use client';

import { useState, useCallback, type Dispatch, type SetStateAction } from 'react';
import type {
  FrameAnalysis,
  ChatMessage,
  TranscriptSegment,
  MeetingSignal,
  MeetingSignalSource,
  MeetingSignalsPayload,
} from '@/types';

const MAX_CONTEXT_CHARS = 2000;
const MAX_TRANSCRIPT_SEGMENTS = 80;
const TRANSCRIPT_MERGE_WINDOW_MS = 12000;
const TRAILING_PUNCTUATION_RE = /[.!?,;:]+$/;
const MAX_MEETING_SIGNALS = 120;
const SIGNAL_DEDUPE_STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'at',
  'by',
  'for',
  'from',
  'in',
  'into',
  'of',
  'on',
  'or',
  'the',
  'to',
  'via',
  'with',
  'must',
  'need',
  'needs',
  'should',
  'please',
  'complete',
  'submit',
  'review',
  'prepare',
  'ensure',
  'include',
  'including',
  'write',
  'draft',
  'finalize',
  'hand',
  'turn',
  'send',
  'make',
]);

function mergeTranscriptText(existing: string, incoming: string) {
  if (!existing) return incoming;
  if (!incoming) return existing;
  if (existing === incoming) return existing;
  if (existing.endsWith(incoming)) return existing;
  if (incoming.startsWith(existing)) return incoming;
  return `${existing} ${incoming}`.replace(/\s+/g, ' ').trim();
}

function normalizeSignalText(item: string): string {
  return item
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(TRAILING_PUNCTUATION_RE, '');
}

function tokenizeSignalText(item: string) {
  return normalizeSignalText(item)
    .split(' ')
    .filter((token) => token.length >= 2 && !SIGNAL_DEDUPE_STOPWORDS.has(token));
}

function signalSimilarity(left: string, right: string) {
  const leftTokens = tokenizeSignalText(left);
  const rightTokens = tokenizeSignalText(right);

  if (leftTokens.length === 0 || rightTokens.length === 0) return 0;

  const leftSet = new Set(leftTokens);
  const rightSet = new Set(rightTokens);
  let intersection = 0;
  for (const token of leftSet) {
    if (rightSet.has(token)) {
      intersection += 1;
    }
  }

  const union = new Set([...leftSet, ...rightSet]).size;
  return union === 0 ? 0 : intersection / union;
}

function isNearDuplicateSignal(left: string, right: string) {
  const normalizedLeft = normalizeSignalText(left);
  const normalizedRight = normalizeSignalText(right);

  if (!normalizedLeft || !normalizedRight) return false;
  if (normalizedLeft === normalizedRight) return true;
  if (
    (normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft)) &&
    Math.min(normalizedLeft.length, normalizedRight.length) /
      Math.max(normalizedLeft.length, normalizedRight.length) >=
      0.68
  ) {
    return true;
  }

  return signalSimilarity(left, right) >= 0.74;
}

export function useMeetingContext() {
  const [insights, setInsights] = useState<FrameAnalysis[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [context, setContext] = useState('');
  const [allActionItems, setAllActionItems] = useState<string[]>([]);
  const [actionSignals, setActionSignals] = useState<MeetingSignal[]>([]);
  const [decisionSignals, setDecisionSignals] = useState<MeetingSignal[]>([]);
  const [openQuestionSignals, setOpenQuestionSignals] = useState<MeetingSignal[]>([]);
  const [transcriptSegments, setTranscriptSegments] = useState<TranscriptSegment[]>([]);

  const mergeSignalEntries = useCallback(
    (
      items: string[],
      source: MeetingSignalSource,
      setSignals: Dispatch<SetStateAction<MeetingSignal[]>>
    ) => {
      if (!items.length) return;

      setSignals((prev) => {
        const next = [...prev];
        const now = Date.now();

        for (const item of items) {
          if (typeof item !== 'string') continue;
          const clean = item.trim();
          if (!clean) continue;
          if (!normalizeSignalText(clean)) continue;
          if (next.some((existing) => isNearDuplicateSignal(existing.text, clean))) continue;
          next.push({
            id: crypto.randomUUID(),
            text: clean,
            timestamp: now,
            source,
          });
        }

        return next.slice(-MAX_MEETING_SIGNALS);
      });
    },
    []
  );

  const mergeActionItems = useCallback(
    (items: string[], source: MeetingSignalSource) => {
      if (!items.length) return;

      const inserted: string[] = [];

      setAllActionItems((prev) => {
        const newItems: string[] = [];
        for (const item of items) {
          if (typeof item !== 'string') continue;
          const clean = item.trim();
          if (!clean) continue;
          if (!normalizeSignalText(clean)) continue;
          if (
            prev.some((existing) => isNearDuplicateSignal(existing, clean)) ||
            newItems.some((existing) => isNearDuplicateSignal(existing, clean))
          ) {
            continue;
          }
          newItems.push(clean);
          inserted.push(clean);
        }
        if (!newItems.length) return prev;
        return [...prev, ...newItems];
      });

      if (!inserted.length) return;
      mergeSignalEntries(inserted, source, setActionSignals);
    },
    [mergeSignalEntries]
  );

  const addMeetingSignals = useCallback(
    (signals: MeetingSignalsPayload, source: MeetingSignalSource = 'speech') => {
      mergeActionItems(signals.actionItems || [], source);
      mergeSignalEntries(signals.decisions || [], source, setDecisionSignals);
      mergeSignalEntries(signals.openQuestions || [], source, setOpenQuestionSignals);
    },
    [mergeActionItems, mergeSignalEntries]
  );

  const addInsight = useCallback(
    (analysis: FrameAnalysis) => {
      setInsights((prev) => [...prev, analysis]);
      setContext(analysis.contextForNext || '');

      if (analysis.actionItems?.length) {
        mergeActionItems(analysis.actionItems, 'vision');
      }
    },
    [mergeActionItems]
  );

  const addActionItems = useCallback(
    (items: string[]) => {
      addMeetingSignals({ actionItems: items }, 'speech');
    },
    [addMeetingSignals]
  );

  const addMessage = useCallback((msg: Omit<ChatMessage, 'id' | 'timestamp'>) => {
    const full: ChatMessage = {
      ...msg,
      id: crypto.randomUUID(),
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, full]);
    return full;
  }, []);

  const addTranscriptSegment = useCallback((segment: Omit<TranscriptSegment, 'id' | 'timestamp'>) => {
    const text = segment.text.replace(/\s+/g, ' ').trim();
    if (!text) return null;

    const full: TranscriptSegment = {
      ...segment,
      text,
      id: crypto.randomUUID(),
      timestamp: Date.now(),
    };

    setTranscriptSegments((prev) => {
      const last = prev[prev.length - 1];

      if (last?.text === full.text) {
        return prev;
      }

      if (last && full.timestamp - last.timestamp <= TRANSCRIPT_MERGE_WINDOW_MS) {
        const merged = mergeTranscriptText(last.text, full.text);

        if (merged !== last.text) {
          const next = [...prev.slice(0, -1), { ...last, text: merged, timestamp: full.timestamp }];
          return next.slice(-MAX_TRANSCRIPT_SEGMENTS);
        }
      }

      const next = [...prev, full];
      return next.slice(-MAX_TRANSCRIPT_SEGMENTS);
    });

    return full;
  }, []);

  const getTranscriptSummary = useCallback(() => {
    const recent = transcriptSegments.slice(-8);
    const summary = recent
      .map((segment) => `[${new Date(segment.timestamp).toLocaleTimeString()}] ${segment.text}`)
      .join('\n');
    return summary.slice(-MAX_CONTEXT_CHARS);
  }, [transcriptSegments]);

  const getScreenSummary = useCallback(() => {
    const recentInsights = insights.slice(-5);
    const visualSummary = recentInsights
      .map((insight) => `[${new Date(insight.timestamp).toLocaleTimeString()}] ${insight.summary}`)
      .join('\n');
    return visualSummary.slice(-MAX_CONTEXT_CHARS);
  }, [insights]);

  const getContextSummary = useCallback(() => {
    const visualSummary = getScreenSummary();
    const transcriptSummary = getTranscriptSummary();

    return [visualSummary && `Screen:\n${visualSummary}`, transcriptSummary && `Speech:\n${transcriptSummary}`]
      .filter(Boolean)
      .join('\n\n')
      .slice(-MAX_CONTEXT_CHARS);
  }, [getScreenSummary, getTranscriptSummary]);

  const reset = useCallback(() => {
    setInsights([]);
    setMessages([]);
    setContext('');
    setAllActionItems([]);
    setActionSignals([]);
    setDecisionSignals([]);
    setOpenQuestionSignals([]);
    setTranscriptSegments([]);
  }, []);

  return {
    insights,
    messages,
    context,
    allActionItems,
    actionSignals,
    decisionSignals,
    openQuestionSignals,
    transcriptSegments,
    addInsight,
    addMeetingSignals,
    addActionItems,
    addMessage,
    addTranscriptSegment,
    getTranscriptSummary,
    getScreenSummary,
    getContextSummary,
    reset,
  };
}
