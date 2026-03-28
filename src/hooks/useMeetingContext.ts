'use client';

import { useState, useCallback } from 'react';
import type { FrameAnalysis, ChatMessage } from '@/types';

const MAX_CONTEXT_CHARS = 2000;

export function useMeetingContext() {
  const [insights, setInsights] = useState<FrameAnalysis[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [context, setContext] = useState('');
  const [allActionItems, setAllActionItems] = useState<string[]>([]);

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

  const getContextSummary = useCallback(() => {
    const recent = insights.slice(-5);
    const summary = recent
      .map((i) => `[${new Date(i.timestamp).toLocaleTimeString()}] ${i.summary}`)
      .join('\n');
    return summary.slice(-MAX_CONTEXT_CHARS);
  }, [insights]);

  const reset = useCallback(() => {
    setInsights([]);
    setMessages([]);
    setContext('');
    setAllActionItems([]);
  }, []);

  return {
    insights,
    messages,
    context,
    allActionItems,
    addInsight,
    addMessage,
    getContextSummary,
    reset,
  };
}
