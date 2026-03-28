'use client';

import { Button } from '@/components/ui/button';

interface Props {
  isCapturing: boolean;
  isAnalyzing: boolean;
  captureError: string | null;
  analysisError: string | null;
  onStart: () => void;
  onStop: () => void;
}

export default function ScreenCapture({
  isCapturing,
  isAnalyzing,
  captureError,
  analysisError,
  onStart,
  onStop,
}: Props) {
  return (
    <div className="flex flex-col items-center gap-6">
      {/* Status ring */}
      <div className="relative flex items-center justify-center w-32 h-32">
        <div
          className={`absolute inset-0 rounded-full border-2 transition-all duration-500 ${
            captureError
              ? 'border-red-500/50'
              : isCapturing
              ? 'border-indigo-500 shadow-[0_0_30px_rgba(99,102,241,0.4)]'
              : 'border-gray-700'
          }`}
        />
        {isCapturing && (
          <div className="absolute inset-0 rounded-full border-2 border-indigo-400/30 animate-ping" />
        )}
        <div
          className={`w-20 h-20 rounded-full flex items-center justify-center text-4xl transition-all ${
            captureError
              ? 'bg-red-500/10'
              : isCapturing
              ? 'bg-indigo-500/20'
              : 'bg-gray-800'
          }`}
        >
          {captureError ? '⚠' : isCapturing ? '👁' : '🖥'}
        </div>
      </div>

      {/* Status text */}
      <div className="text-center space-y-1 max-w-xs">
        {captureError ? (
          <p className="text-red-400 text-xs leading-snug">{captureError}</p>
        ) : isCapturing ? (
          <>
            <p className="text-indigo-300 font-medium text-sm">Watching your screen</p>
            {isAnalyzing ? (
              <p className="text-gray-500 text-xs animate-pulse">Analyzing frame...</p>
            ) : (
              <p className="text-gray-500 text-xs">Next analysis in ~3s</p>
            )}
          </>
        ) : (
          <>
            <p className="text-gray-300 font-medium text-sm">Ready to watch</p>
            <p className="text-gray-500 text-xs">Analyzes your screen every 3 seconds</p>
          </>
        )}
      </div>

      {/* API error */}
      {analysisError && (
        <div className="max-w-xs bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 text-xs text-red-300 text-center leading-snug">
          {analysisError}
        </div>
      )}

      {/* Controls */}
      {isCapturing ? (
        <Button
          onClick={onStop}
          variant="outline"
          className="border-red-500/50 text-red-400 hover:bg-red-500/10 hover:border-red-400"
        >
          Stop Capture
        </Button>
      ) : (
        <Button
          onClick={onStart}
          className="bg-indigo-600 hover:bg-indigo-500 text-white px-6"
        >
          {captureError ? 'Try Again' : 'Start Capture'}
        </Button>
      )}

      {/* How it works */}
      {!isCapturing && !captureError && (
        <div className="grid grid-cols-3 gap-4 mt-4 max-w-sm text-center">
          {[
            { icon: '📸', label: 'Captures frames', sub: 'every 3 seconds' },
            { icon: '🔍', label: 'Gemini Vision', sub: 'analyzes content' },
            { icon: '💬', label: 'Claude AI', sub: 'answers questions' },
          ].map((item) => (
            <div key={item.label} className="flex flex-col items-center gap-1">
              <span className="text-2xl">{item.icon}</span>
              <span className="text-xs text-gray-300 font-medium">{item.label}</span>
              <span className="text-xs text-gray-500">{item.sub}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
