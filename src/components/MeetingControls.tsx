'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import type { FrameAnalysis, TranscriptSegment } from '@/types';

interface Props {
  insights: FrameAnalysis[];
  actionItems: string[];
  transcriptSegments: TranscriptSegment[];
  startTime: number | null;
}

export default function MeetingControls({
  insights,
  actionItems,
  transcriptSegments,
  startTime,
}: Props) {
  const [isExporting, setIsExporting] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const hasMeetingData = insights.length > 0 || transcriptSegments.length > 0;

  const handleExport = async () => {
    if (!hasMeetingData) return;
    setIsExporting(true);
    try {
      const duration = startTime ? Math.round((Date.now() - startTime) / 60000) : undefined;
      const res = await fetch('/api/summarize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ insights, actionItems, transcriptSegments, duration }),
      });
      const data = await res.json();
      setSummary(data.summary || null);
    } catch (err) {
      console.error('Export failed:', err);
    }
    setIsExporting(false);
  };

  const handleDownload = () => {
    if (!summary) return;
    const blob = new Blob([summary], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `meeting-summary-${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!hasMeetingData) return null;

  return (
    <div className="mt-4 flex flex-col gap-2">
      {!summary ? (
        <Button
          onClick={handleExport}
          disabled={isExporting}
          variant="outline"
          size="sm"
          className="border-gray-600 text-gray-300 hover:bg-gray-700 w-full text-xs"
        >
          {isExporting ? (
            <span className="animate-pulse">Generating summary...</span>
          ) : (
            '📋 Export Meeting Summary'
          )}
        </Button>
      ) : (
        <div className="space-y-2">
          <div className="bg-gray-900 rounded border border-gray-700 p-3 max-h-48 overflow-y-auto">
            <pre className="text-xs text-gray-300 whitespace-pre-wrap font-sans">{summary}</pre>
          </div>
          <div className="flex gap-2">
            <Button
              onClick={handleDownload}
              size="sm"
              className="flex-1 bg-indigo-600 hover:bg-indigo-500 text-xs"
            >
              ↓ Download .md
            </Button>
            <Button
              onClick={() => setSummary(null)}
              variant="outline"
              size="sm"
              className="border-gray-600 text-gray-400 hover:bg-gray-700 text-xs"
            >
              ✕
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
