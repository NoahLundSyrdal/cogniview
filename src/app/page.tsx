'use client';

import { useState, useCallback, useRef } from 'react';
import { useScreenCapture } from '@/hooks/useScreenCapture';
import { useMeetingContext } from '@/hooks/useMeetingContext';
import ScreenCapture from '@/components/ScreenCapture';
import CopilotSidebar from '@/components/CopilotSidebar';
import type { FrameAnalysis } from '@/types';

export default function Home() {
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [startTime, setStartTime] = useState<number | null>(null);
  const latestAnalysisRef = useRef<FrameAnalysis | null>(null);

  const {
    insights,
    messages,
    context,
    allActionItems,
    addInsight,
    addMessage,
    getContextSummary,
    reset,
  } = useMeetingContext();

  const handleFrame = useCallback(
    async (frame: string) => {
      setIsAnalyzing(true);
      setAnalysisError(null);
      try {
        const res = await fetch('/api/analyze-frame', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ frame, previousContext: context }),
        });
        const data = await res.json();
        if (!res.ok) {
          setAnalysisError(data.error || `Analysis failed (HTTP ${res.status})`);
        } else {
          const analysis: FrameAnalysis = { ...data, timestamp: Date.now() };
          addInsight(analysis);
          latestAnalysisRef.current = analysis;
        }
      } catch (err) {
        setAnalysisError('Network error — check your connection.');
        console.error('Frame analysis failed:', err);
      }
      setIsAnalyzing(false);
    },
    [context, addInsight]
  );

  const { isCapturing, captureError, startCapture, stopCapture } = useScreenCapture(handleFrame);

  const handleStart = useCallback(async () => {
    reset();
    setStartTime(Date.now());
    setAnalysisError(null);
    await startCapture();
  }, [reset, startCapture]);

  const handleStop = useCallback(() => {
    stopCapture();
  }, [stopCapture]);

  const handleSendMessage = useCallback(
    async (message: string) => {
      addMessage({ role: 'user', content: message });
      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message,
            meetingContext: getContextSummary(),
            screenAnalysis: latestAnalysisRef.current,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          addMessage({ role: 'assistant', content: `Error: ${data.error || 'Chat failed'}` });
        } else {
          addMessage({ role: 'assistant', content: data.response });
        }
      } catch (err) {
        console.error('Chat failed:', err);
        addMessage({ role: 'assistant', content: 'Network error. Please try again.' });
      }
    },
    [addMessage, getContextSummary]
  );

  return (
    <div className="flex h-screen bg-gray-950 text-white overflow-hidden">
      {/* Main area */}
      <div className="flex-1 flex flex-col items-center justify-center p-8 relative">
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
            captureError={captureError}
            analysisError={analysisError}
            onStart={handleStart}
            onStop={handleStop}
          />
        </div>

        {isCapturing && (
          <div className="relative z-10 mt-10 flex gap-6 text-center">
            {[
              { label: 'Frames analyzed', value: insights.length },
              { label: 'Action items', value: allActionItems.length },
              { label: 'Messages', value: messages.length },
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
        </div>
      </div>

      <CopilotSidebar
        insights={insights}
        messages={messages}
        isCapturing={isCapturing}
        isAnalyzing={isAnalyzing}
        allActionItems={allActionItems}
        context={context}
        onSendMessage={handleSendMessage}
        startTime={startTime}
      />
    </div>
  );
}
