'use client';

import { useState, useCallback } from 'react';
import type { FrameAnalysis, ChatMessage, TranscriptSegment } from '@/types';

const MAX_CONTEXT_CHARS = 2000;
const MAX_TRANSCRIPT_SEGMENTS = 80;
const TRANSCRIPT_MERGE_WINDOW_MS = 12000;
const TRAILING_PUNCTUATION_RE = /[.!?,;:]+$/;
const MAX_LIVE_SUMMARY_CHARS = 320;
const MAX_COMMITMENTS = 120;
const DEFAULT_COMMITMENTS_WINDOW_MS = 120000;
const DEFAULT_COMMITMENTS_MAX_ITEMS = 2;

interface MeetingCommitment {
  id: string;
  text: string;
  timestamp: number;
  source: 'vision' | 'speech';
}

function mergeTranscriptText(existing: string, incoming: string) {
  if (!existing) return incoming;
  if (!incoming) return existing;
  if (existing === incoming) return existing;
  if (existing.endsWith(incoming)) return existing;
  if (incoming.startsWith(existing)) return incoming;
  return `${existing} ${incoming}`.replace(/\s+/g, ' ').trim();
}

function normalizeActionItem(item: string): string {
  return item
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(TRAILING_PUNCTUATION_RE, '');
}

export function useMeetingContext() {
  const [insights, setInsights] = useState<FrameAnalysis[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [context, setContext] = useState('');
  const [allActionItems, setAllActionItems] = useState<string[]>([]);
  const [commitments, setCommitments] = useState<MeetingCommitment[]>([]);
  const [transcriptSegments, setTranscriptSegments] = useState<TranscriptSegment[]>([]);

  const mergeActionItems = useCallback((items: string[], source: MeetingCommitment['source']) => {
    if (!items.length) return;

    const inserted: Array<{ text: string; key: string }> = [];

    setAllActionItems((prev) => {
      const existingKeys = new Set(prev.map((item) => normalizeActionItem(item)));
      const newItems: string[] = [];
      for (const item of items) {
        if (typeof item !== 'string') continue;
        const clean = item.trim();
        if (!clean) continue;
        const key = normalizeActionItem(clean);
        if (!key || existingKeys.has(key)) continue;
        existingKeys.add(key);
        newItems.push(clean);
        inserted.push({ text: clean, key });
      }
      if (!newItems.length) return prev;
      return [...prev, ...newItems];
    });

    if (!inserted.length) return;

    setCommitments((prev) => {
      const now = Date.now();
      const seenKeys = new Set(prev.map((item) => normalizeActionItem(item.text)));
      const newCommitments: MeetingCommitment[] = [];
      for (const entry of inserted) {
        if (!entry.key || seenKeys.has(entry.key)) continue;
        seenKeys.add(entry.key);
        newCommitments.push({
          id: crypto.randomUUID(),
          text: entry.text,
          timestamp: now,
          source,
        });
      }
      if (!newCommitments.length) return prev;
      return [...prev, ...newCommitments].slice(-MAX_COMMITMENTS);
    });
  }, []);

  const addInsight = useCallback((analysis: FrameAnalysis) => {
    setInsights((prev) => [...prev, analysis]);
    setContext(analysis.contextForNext || '');

    if (analysis.actionItems?.length) {
      mergeActionItems(analysis.actionItems, 'vision');
    }
  }, [mergeActionItems]);

  const addActionItems = useCallback((items: string[]) => {
    mergeActionItems(items, 'speech');
  }, [mergeActionItems]);

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

  const getContextSummary = useCallback(() => {
    const recentInsights = insights.slice(-5);
    const visualSummary = recentInsights
      .map((i) => `[${new Date(i.timestamp).toLocaleTimeString()}] ${i.summary}`)
      .join('\n');
    const transcriptSummary = getTranscriptSummary();

    return [visualSummary && `Screen:\n${visualSummary}`, transcriptSummary && `Speech:\n${transcriptSummary}`]
      .filter(Boolean)
      .join('\n\n')
      .slice(-MAX_CONTEXT_CHARS);
  }, [getTranscriptSummary, insights]);

  const getLiveNowSummary = useCallback(() => {
    const latestInsight = insights[insights.length - 1];
    const latestTranscript = transcriptSegments[transcriptSegments.length - 1];

    const visualLine = latestInsight?.summary?.trim() || '';
    const speechLine = latestTranscript?.text?.trim() || '';

    if (visualLine && speechLine) {
      return `${visualLine} Speaker says: ${speechLine}`.slice(0, MAX_LIVE_SUMMARY_CHARS);
    }
    if (speechLine) {
      return `Speaker says: ${speechLine}`.slice(0, MAX_LIVE_SUMMARY_CHARS);
    }
    if (visualLine) {
      return visualLine.slice(0, MAX_LIVE_SUMMARY_CHARS);
    }

    return '';
  }, [insights, transcriptSegments]);

  const getRecentCommitments = useCallback(
    (windowMs = DEFAULT_COMMITMENTS_WINDOW_MS, maxItems = DEFAULT_COMMITMENTS_MAX_ITEMS) => {
      const safeWindowMs = Number.isFinite(windowMs) ? Math.max(1000, Math.floor(windowMs)) : DEFAULT_COMMITMENTS_WINDOW_MS;
      const safeMaxItems = Number.isFinite(maxItems) ? Math.max(1, Math.floor(maxItems)) : DEFAULT_COMMITMENTS_MAX_ITEMS;
      const cutoff = Date.now() - safeWindowMs;
      return commitments
        .filter((item) => item.timestamp >= cutoff)
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, safeMaxItems)
        .map((item) => item.text);
    },
    [commitments]
  );

  const reset = useCallback(() => {
    setInsights([]);
    setMessages([]);
    setContext('');
    setAllActionItems([]);
    setCommitments([]);
    setTranscriptSegments([]);
  }, []);

  return {
    insights,
    messages,
    context,
    allActionItems,
    transcriptSegments,
    addInsight,
    addActionItems,
    addMessage,
    addTranscriptSegment,
    getTranscriptSummary,
    getContextSummary,
    getLiveNowSummary,
    getRecentCommitments,
    reset,
  };
}
