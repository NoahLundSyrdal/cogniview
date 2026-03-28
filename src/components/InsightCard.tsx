'use client';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import type { FrameAnalysis } from '@/types';

const screenTypeColors: Record<string, string> = {
  slides: 'bg-blue-500/20 text-blue-300 border-blue-500/30',
  code: 'bg-green-500/20 text-green-300 border-green-500/30',
  document: 'bg-yellow-500/20 text-yellow-300 border-yellow-500/30',
  dashboard: 'bg-purple-500/20 text-purple-300 border-purple-500/30',
  video: 'bg-red-500/20 text-red-300 border-red-500/30',
  browser: 'bg-cyan-500/20 text-cyan-300 border-cyan-500/30',
  other: 'bg-gray-500/20 text-gray-300 border-gray-500/30',
};

interface Props {
  insight: FrameAnalysis;
  isLatest?: boolean;
}

export default function InsightCard({ insight, isLatest }: Props) {
  const colorClass = screenTypeColors[insight.screenType] || screenTypeColors.other;
  const time = new Date(insight.timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  return (
    <Card
      className={`border-gray-700/50 bg-gray-800/50 ${isLatest ? 'ring-1 ring-indigo-500/40' : ''}`}
    >
      <CardContent className="p-3 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <Badge variant="outline" className={`text-xs ${colorClass}`}>
            {insight.screenType}
          </Badge>
          <span className="text-xs text-gray-500">{time}</span>
        </div>

        <p className="text-sm text-gray-200 leading-snug">{insight.summary}</p>

        {insight.keyPoints?.length > 0 && (
          <ul className="space-y-1">
            {insight.keyPoints.map((point, i) => (
              <li key={i} className="text-xs text-gray-400 flex gap-1.5">
                <span className="text-indigo-400 mt-0.5">•</span>
                <span>{point}</span>
              </li>
            ))}
          </ul>
        )}

        {insight.suggestedQuestions?.length > 0 && (
          <div className="pt-1 space-y-1">
            {insight.suggestedQuestions.map((q, i) => (
              <div
                key={i}
                className="text-xs text-amber-300/80 bg-amber-500/10 rounded px-2 py-1 border border-amber-500/20"
              >
                ? {q}
              </div>
            ))}
          </div>
        )}

        {insight.factCheckFlags?.length > 0 && (
          <div className="pt-1 space-y-1">
            {insight.factCheckFlags.map((flag, i) => (
              <div
                key={i}
                className="text-xs text-orange-300/80 bg-orange-500/10 rounded px-2 py-1 border border-orange-500/20"
              >
                ⚑ {flag}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
