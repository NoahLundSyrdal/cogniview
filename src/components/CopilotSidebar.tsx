'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import InsightCard from './InsightCard';
import ActionItems from './ActionItems';
import MeetingControls from './MeetingControls';
import type { FrameAnalysis, ChatMessage, TranscriptSegment } from '@/types';

interface Props {
  insights: FrameAnalysis[];
  messages: ChatMessage[];
  isCapturing: boolean;
  isAnalyzing: boolean;
  isTranscribing: boolean;
  allActionItems: string[];
  transcriptSegments: TranscriptSegment[];
  onSendMessage: (msg: string) => Promise<void>;
  startTime: number | null;
}

type Tab = 'insights' | 'transcript' | 'actions' | 'chat';

export default function CopilotSidebar({
  insights,
  messages,
  isCapturing,
  isAnalyzing,
  isTranscribing,
  allActionItems,
  transcriptSegments,
  onSendMessage,
  startTime,
}: Props) {
  const [tab, setTab] = useState<Tab>('insights');
  const [input, setInput] = useState('');
  const [isSending, setIsSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (tab === 'chat') {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, tab]);

  const handleSend = useCallback(async () => {
    const msg = input.trim();
    if (!msg || isSending) return;
    setInput('');
    setIsSending(true);
    await onSendMessage(msg);
    setIsSending(false);
  }, [input, isSending, onSendMessage]);

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: 'insights', label: 'Insights', count: insights.length || undefined },
    { id: 'transcript', label: 'Transcript', count: transcriptSegments.length || undefined },
    { id: 'actions', label: 'Actions', count: allActionItems.length || undefined },
    { id: 'chat', label: 'Chat', count: messages.length || undefined },
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
              <ActionItems items={allActionItems} />
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
          <div className="flex flex-col h-full">
            <ScrollArea className="flex-1">
              <div className="p-3 space-y-3">
                {messages.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12 text-center gap-3">
                    <span className="text-3xl opacity-40">💬</span>
                    <p className="text-sm text-gray-500">Ask anything about what&apos;s on screen</p>
                    <div className="space-y-1.5 text-left w-full">
                      {[
                        'What are the main takeaways?',
                        'What question should I ask?',
                        'Explain this slide',
                      ].map((suggestion) => (
                        <button
                          key={suggestion}
                          onClick={() => setInput(suggestion)}
                          className="w-full text-left text-xs text-gray-500 border border-gray-700 rounded px-2 py-1.5 hover:border-indigo-500/50 hover:text-gray-300 transition-colors"
                        >
                          {suggestion}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  messages.map((msg) => (
                    <div
                      key={msg.id}
                      className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                    >
                      <div
                        className={`max-w-[85%] rounded-lg px-3 py-2 text-xs leading-relaxed ${
                          msg.role === 'user'
                            ? 'bg-indigo-600 text-white'
                            : 'bg-gray-800 text-gray-200 border border-gray-700'
                        }`}
                      >
                        {msg.content}
                      </div>
                    </div>
                  ))
                )}
                {isSending && (
                  <div className="flex justify-start">
                    <div className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2">
                      <span className="flex gap-1">
                        {[0, 1, 2].map((i) => (
                          <span
                            key={i}
                            className="w-1 h-1 bg-gray-400 rounded-full animate-bounce"
                            style={{ animationDelay: `${i * 150}ms` }}
                          />
                        ))}
                      </span>
                    </div>
                  </div>
                )}
                <div ref={bottomRef} />
              </div>
            </ScrollArea>

            <div className="p-3 border-t border-gray-800 flex gap-2">
              <Input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKey}
                placeholder="Ask about what's on screen..."
                className="flex-1 bg-gray-800 border-gray-700 text-gray-100 placeholder-gray-500 text-xs h-8"
              />
              <Button
                onClick={handleSend}
                disabled={!input.trim() || isSending}
                size="sm"
                className="bg-indigo-600 hover:bg-indigo-500 text-white h-8 px-3 text-xs"
              >
                ↑
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
