'use client';

import { useState, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';
import { useScreenCapture } from '@/hooks/useScreenCapture';
import { useDetachedWindow } from '@/hooks/useDetachedWindow';
import { useMeetingContext } from '@/hooks/useMeetingContext';
import ScreenCapture from '@/components/ScreenCapture';
import CopilotSidebar from '@/components/CopilotSidebar';
import type { FactCheckResult, FactCheckStatement, FrameAnalysis } from '@/types';

export default function Home() {
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [transcriptError, setTranscriptError] = useState<string | null>(null);
  const [activeTranscriptJobs, setActiveTranscriptJobs] = useState(0);
  const [startTime, setStartTime] = useState<number | null>(null);
  const [isFactChecking, setIsFactChecking] = useState(false);
  const [factCheckError, setFactCheckError] = useState<string | null>(null);
  const [factCheckClaims, setFactCheckClaims] = useState<string[]>([]);
  const [factCheckStatements, setFactCheckStatements] = useState<FactCheckStatement[]>([]);
  const [factCheckResults, setFactCheckResults] = useState<FactCheckResult[]>([]);
  const latestAnalysisRef = useRef<FrameAnalysis | null>(null);
  const latestFrameRef = useRef<string | null>(null);
  const transcriptQueueRef = useRef<Promise<void>>(Promise.resolve());
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
    messages,
    context,
    allActionItems,
    transcriptSegments,
    addInsight,
    addMessage,
    addTranscriptSegment,
    getTranscriptSummary,
    getContextSummary,
    getScreenSummary,
    reset,
  } = useMeetingContext();

  const handleFrame = useCallback(
    async (frame: string) => {
      latestFrameRef.current = frame;
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

  const { isCapturing, captureError, startCapture, stopCapture } = useScreenCapture({
    onFrame: handleFrame,
    onAudioChunk: handleAudioChunk,
  });

  const handleStart = useCallback(async () => {
    const sidebarWindowPromise = openSidebarWindow().catch((error) => {
      console.error('Opening floating sidebar failed:', error);
      return false;
    });

    reset();
    setStartTime(null);
    setAnalysisError(null);
    setTranscriptError(null);
    setActiveTranscriptJobs(0);
    latestFrameRef.current = null;
    transcriptQueueRef.current = Promise.resolve();
    setFactCheckError(null);
    setFactCheckClaims([]);
    setFactCheckStatements([]);
    setFactCheckResults([]);
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
    stopCapture();
  }, [stopCapture]);

  const handleRunFactCheck = useCallback(async () => {
    const latestFrame = latestFrameRef.current;
    if (!latestFrame) {
      setFactCheckError('No captured frame available yet.');
      return;
    }

    setFactCheckError(null);
    setIsFactChecking(true);
    try {
      const res = await fetch('/api/fact-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          frame: latestFrame,
          meetingContext: getContextSummary(),
          screenContext: getScreenSummary(),
          transcriptContext: getTranscriptSummary(),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setFactCheckError(data.error || 'Fact-check failed');
        return;
      }
      setFactCheckClaims(Array.isArray(data.claims) ? data.claims : []);
      setFactCheckStatements(Array.isArray(data.statements) ? data.statements : []);
      setFactCheckResults(Array.isArray(data.results) ? data.results : []);
    } catch (err) {
      console.error('Fact-check failed:', err);
      setFactCheckError('Network error. Please try again.');
    } finally {
      setIsFactChecking(false);
    }
  }, [getContextSummary, getScreenSummary, getTranscriptSummary]);

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
            transcriptContext: getTranscriptSummary(),
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
    [addMessage, getContextSummary, getTranscriptSummary]
  );

  const sidebarProps = {
    insights,
    messages,
    isCapturing,
    isAnalyzing: isAnalyzing || activeTranscriptJobs > 0,
    transcriptError,
    isTranscribing: activeTranscriptJobs > 0,
    allActionItems,
    transcriptSegments,
    onSendMessage: handleSendMessage,
    startTime,
    factCheckClaims,
    factCheckStatements,
    factCheckResults,
    factCheckError,
    isFactChecking,
    onRunFactCheck: handleRunFactCheck,
  };

  return (
    <>
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
              isAnalyzing={isAnalyzing || activeTranscriptJobs > 0}
              isTranscribing={activeTranscriptJobs > 0}
              captureError={captureError}
              analysisError={analysisError}
              transcriptError={transcriptError}
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
