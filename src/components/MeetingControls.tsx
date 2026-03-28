'use client';

import FinalSummaryCard from '@/components/FinalSummaryCard';
import type { FrameAnalysis, TranscriptSegment } from '@/types';

interface Props {
  isCapturing: boolean;
  insights: FrameAnalysis[];
  transcriptSegments: TranscriptSegment[];
  isGeneratingSummary: boolean;
  summary: string | null;
  summaryError: string | null;
  onGenerateSummary: () => void;
}

export default function MeetingControls({
  isCapturing,
  insights,
  transcriptSegments,
  isGeneratingSummary,
  summary,
  summaryError,
  onGenerateSummary,
}: Props) {
  const hasMeetingData = insights.length > 0 || transcriptSegments.length > 0;

  return (
    <div className="mt-4">
      <FinalSummaryCard
        variant="sidebar"
        summary={summary}
        summaryError={summaryError}
        isGeneratingSummary={isGeneratingSummary}
        isCapturing={isCapturing}
        hasMeetingData={hasMeetingData}
        onGenerateSummary={onGenerateSummary}
      />
    </div>
  );
}
