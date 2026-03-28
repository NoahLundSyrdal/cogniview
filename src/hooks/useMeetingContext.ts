'use client';

import { useState, useCallback } from 'react';
import type { FrameAnalysis, ChatMessage, TranscriptSegment } from '@/types';

const MAX_CONTEXT_CHARS = 2000;
const MAX_TRANSCRIPT_SEGMENTS = 80;
const TRANSCRIPT_MERGE_WINDOW_MS = 12000;
const TRAILING_PUNCTUATION_RE = /[.!?,;:]+$/;

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
  const [transcriptSegments, setTranscriptSegments] = useState<TranscriptSegment[]>([]);

  const addInsight = useCallback((analysis: FrameAnalysis) => {
    setInsights((prev) => [...prev, analysis]);
    setContext(analysis.contextForNext || '');

    if (analysis.actionItems?.length) {
      setAllActionItems((prev) => {
        const existingKeys = new Set(prev.map((item) => normalizeActionItem(item)));
        const newItems: string[] = [];
        for (const item of analysis.actionItems) {
          if (typeof item !== 'string') continue;
          const clean = item.trim();
          if (!clean) continue;
          const key = normalizeActionItem(clean);
          if (!key || existingKeys.has(key)) continue;
          existingKeys.add(key);
          newItems.push(clean);
        }
        return [...prev, ...newItems];
      });
    }
  }, []);

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

  const reset = useCallback(() => {
    setInsights([]);
    setMessages([]);
    setContext('');
    setAllActionItems([]);
    setTranscriptSegments([]);
  }, []);

  return {
    insights,
    messages,
    context,
    allActionItems,
    transcriptSegments,
    addInsight,
    addMessage,
    addTranscriptSegment,
    getTranscriptSummary,
    getContextSummary,
    reset,
  };
}
