'use client';

import { useEffect, useMemo, useState } from 'react';
import { useChat } from '@ai-sdk/react';
import { AssistantRuntimeProvider, ComposerPrimitive, MessagePrimitive, ThreadPrimitive } from '@assistant-ui/react';
import { AssistantChatTransport, useAISDKRuntime } from '@assistant-ui/react-ai-sdk';
import type { FrameAnalysis } from '@/types';

type AssistantChatMode = 'v1' | 'v2';

interface Props {
  meetingContext: string;
  screenAnalysis: FrameAnalysis | null;
  transcriptContext: string;
  sessionId: string;
  onMessageCountChange?: (count: number) => void;
}

const SUGGESTIONS = [
  'What are the main takeaways?',
  'What question should I ask next?',
  'Explain what is on screen in plain English.',
];

export default function AssistantCopilotChat({
  meetingContext,
  screenAnalysis,
  transcriptContext,
  sessionId,
  onMessageCountChange,
}: Props) {
  const [mode, setMode] = useState<AssistantChatMode>(
    process.env.NEXT_PUBLIC_ASSISTANT_UI_DEFAULT_MODE === 'v1' ? 'v1' : 'v2'
  );

  const transport = useMemo(
    () =>
      new AssistantChatTransport({
        api: '/api/assistant-ui/chat',
        body: async () => ({
          mode,
          meetingContext,
          transcriptContext,
          screenAnalysis,
        }),
      }),
    [meetingContext, mode, screenAnalysis, transcriptContext]
  );

  const chat = useChat({
    id: `${sessionId}-${mode}`,
    transport,
    experimental_throttle: 32,
  });

  const runtime = useAISDKRuntime(chat);

  useEffect(() => {
    transport.setRuntime(runtime);
  }, [runtime, transport]);

  useEffect(() => {
    onMessageCountChange?.(chat.messages.length);
  }, [chat.messages.length, onMessageCountChange]);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="flex h-full flex-col">
        <div className="border-b border-gray-800 px-3 py-2.5">
          <div className="flex items-center justify-between gap-2">
            <div className="space-y-1">
              <div className="text-[10px] uppercase tracking-[0.2em] text-emerald-300">
                Assistant UI
              </div>
              <p className="text-[11px] text-gray-500">
                {mode === 'v1'
                  ? 'v1 streams directly from the model endpoint.'
                  : 'v2 streams through Railtracks while keeping the same chat UX.'}
              </p>
            </div>

            <div className="inline-flex rounded-lg border border-gray-700 bg-gray-950 p-0.5">
              {([
                ['v1', 'Direct'],
                ['v2', 'Railtracks'],
              ] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setMode(value)}
                  className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
                    mode === value
                      ? 'bg-indigo-600 text-white'
                      : 'text-gray-400 hover:text-gray-200'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <ThreadPrimitive.Viewport className="flex-1 overflow-y-auto px-3 py-3">
          {chat.messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
              <span className="text-3xl opacity-40">💬</span>
              <p className="text-sm text-gray-500">Ask anything about what&apos;s on screen</p>
              <div className="w-full space-y-1.5 text-left">
                {SUGGESTIONS.map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    onClick={() => {
                      void chat.sendMessage({ text: suggestion });
                    }}
                    className="w-full rounded border border-gray-700 px-2 py-1.5 text-left text-xs text-gray-500 transition-colors hover:border-indigo-500/50 hover:text-gray-300"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <ThreadPrimitive.Messages>
              {({ message }) => {
                const isUser = message.role === 'user';
                return (
                  <div className={`mb-3 flex ${isUser ? 'justify-end' : 'justify-start'}`}>
                    <MessagePrimitive.Root
                      className={`max-w-[85%] rounded-lg px-3 py-2 text-xs leading-relaxed ${
                        isUser
                          ? 'bg-indigo-600 text-white'
                          : 'border border-gray-700 bg-gray-800 text-gray-200'
                      }`}
                    >
                      <MessagePrimitive.Content />
                    </MessagePrimitive.Root>
                  </div>
                );
              }}
            </ThreadPrimitive.Messages>
          )}
        </ThreadPrimitive.Viewport>

        <div className="border-t border-gray-800 p-3">
          {chat.error && (
            <div className="mb-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] text-red-200">
              {chat.error.message}
            </div>
          )}

          <ComposerPrimitive.Root className="flex items-end gap-2">
            <ComposerPrimitive.Input
              minRows={1}
              maxRows={5}
              placeholder={
                mode === 'v1'
                  ? 'Ask with Assistant UI direct mode...'
                  : 'Ask with Assistant UI + Railtracks...'
              }
              className="min-h-8 flex-1 resize-none rounded-md border border-gray-700 bg-gray-800 px-2.5 py-1.5 text-xs text-gray-100 placeholder:text-gray-500 focus:border-indigo-500 focus:outline-none"
            />
            <ComposerPrimitive.Send className="inline-flex h-8 items-center justify-center rounded-md bg-indigo-600 px-3 text-xs font-medium text-white transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50">
              {chat.status === 'submitted' || chat.status === 'streaming' ? '…' : '↑'}
            </ComposerPrimitive.Send>
          </ComposerPrimitive.Root>
        </div>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}
