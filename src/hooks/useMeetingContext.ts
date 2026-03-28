'use client';

import { useState, useCallback } from 'react';
import type { FrameAnalysis, ChatMessage, TranscriptSegment } from '@/types';

const MAX_CONTEXT_CHARS = 2000;
const MAX_TRANSCRIPT_SEGMENTS = 80;

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
        const newItems = analysis.actionItems.filter((item) => !prev.includes(item));
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
    const text = segment.text.trim();
    if (!text) return null;

    const full: TranscriptSegment = {
      ...segment,
      text,
      id: crypto.randomUUID(),
      timestamp: Date.now(),
    };

    setTranscriptSegments((prev) => {
      if (prev[prev.length - 1]?.text === full.text) {
        return prev;
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
