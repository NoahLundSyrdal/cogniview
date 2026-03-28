'use client';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface Props {
  summary: string | null;
  summaryError: string | null;
  isGeneratingSummary: boolean;
  isCapturing: boolean;
  hasMeetingData: boolean;
  onGenerateSummary: () => void;
  variant?: 'sidebar' | 'main';
  className?: string;
}

export default function FinalSummaryCard({
  summary,
  summaryError,
  isGeneratingSummary,
  isCapturing,
  hasMeetingData,
  onGenerateSummary,
  variant = 'sidebar',
  className,
}: Props) {
  const isMain = variant === 'main';
  const bodyTextClass = isMain ? 'text-sm' : 'text-xs';

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

  if (!hasMeetingData && !summary && !summaryError && !isGeneratingSummary) return null;

  return (
    <div
      className={cn(
        'space-y-3 rounded-2xl border border-gray-800 bg-gray-950/80',
        isMain ? 'p-5 shadow-[0_20px_80px_rgba(0,0,0,0.35)]' : 'p-3',
        className
      )}
    >
      <div className="space-y-1.5">
        <div
          className={cn(
            'uppercase tracking-[0.2em] text-gray-500',
            isMain ? 'text-[11px]' : 'text-[10px]'
          )}
        >
          Final meeting summary
        </div>
        {isMain && (
          <p className="text-sm text-gray-300 leading-relaxed">
            The finished recap combines what was shown on screen, what was said, and what got
            decided or committed.
          </p>
        )}
      </div>

      {isGeneratingSummary ? (
        <div
          className={cn(
            'rounded-xl border border-indigo-500/20 bg-indigo-500/10 px-4 py-3 text-gray-200',
            isMain ? 'text-sm' : 'text-xs'
          )}
        >
          <span className="animate-pulse">
            Finishing the final recap. Pulling together what was shown, what was said, and what
            happened next.
          </span>
        </div>
      ) : summary ? (
        <div
          className={cn(
            'rounded-xl border border-gray-700 bg-gray-900 p-4 overflow-y-auto',
            isMain ? 'max-h-[50vh]' : 'max-h-64'
          )}
        >
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              h1: ({ className, ...props }) => (
                <h1
                  className={cn(
                    'mt-5 first:mt-0 text-lg font-semibold tracking-tight text-white',
                    className
                  )}
                  {...props}
                />
              ),
              h2: ({ className, ...props }) => (
                <h2
                  className={cn(
                    'mt-5 first:mt-0 border-t border-gray-800 pt-4 text-base font-semibold tracking-tight text-indigo-200',
                    className
                  )}
                  {...props}
                />
              ),
              h3: ({ className, ...props }) => (
                <h3
                  className={cn('mt-4 text-sm font-semibold text-gray-100', className)}
                  {...props}
                />
              ),
              p: ({ className, ...props }) => (
                <p
                  className={cn('mt-2 leading-relaxed text-gray-200 first:mt-0', bodyTextClass, className)}
                  {...props}
                />
              ),
              ul: ({ className, ...props }) => (
                <ul
                  className={cn('mt-2 list-disc space-y-2 pl-5 text-gray-200', bodyTextClass, className)}
                  {...props}
                />
              ),
              ol: ({ className, ...props }) => (
                <ol
                  className={cn('mt-2 list-decimal space-y-2 pl-5 text-gray-200', bodyTextClass, className)}
                  {...props}
                />
              ),
              li: ({ className, ...props }) => (
                <li className={cn('leading-relaxed marker:text-gray-500', className)} {...props} />
              ),
              strong: ({ className, ...props }) => (
                <strong className={cn('font-semibold text-white', className)} {...props} />
              ),
              em: ({ className, ...props }) => (
                <em className={cn('italic text-gray-100', className)} {...props} />
              ),
              code: ({ className, ...props }) => (
                <code
                  className={cn(
                    'rounded bg-gray-950 px-1.5 py-0.5 font-mono text-[0.9em] text-indigo-200',
                    className
                  )}
                  {...props}
                />
              ),
              hr: ({ className, ...props }) => (
                <hr className={cn('my-4 border-gray-800', className)} {...props} />
              ),
              a: ({ className, ...props }) => (
                <a
                  className={cn('text-indigo-300 underline decoration-indigo-400/40 underline-offset-2', className)}
                  target="_blank"
                  rel="noreferrer"
                  {...props}
                />
              ),
            }}
          >
            {summary}
          </ReactMarkdown>
        </div>
      ) : summaryError ? (
        <div
          className={cn(
            'rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-red-200',
            isMain ? 'text-sm' : 'text-xs'
          )}
        >
          {summaryError}
        </div>
      ) : isCapturing ? (
        <p className={cn('leading-relaxed text-gray-400', isMain ? 'text-sm' : 'text-xs')}>
          When you stop capture, CogniView will create one final recap that combines the screen,
          transcript, and extracted commitments.
        </p>
      ) : hasMeetingData ? (
        <p className={cn('leading-relaxed text-gray-400', isMain ? 'text-sm' : 'text-xs')}>
          Generate a final recap for this completed session.
        </p>
      ) : (
        <p className={cn('leading-relaxed text-gray-500', isMain ? 'text-sm' : 'text-xs')}>
          Capture some meeting context to generate a final recap.
        </p>
      )}

      {summary ? (
        <div className="flex gap-2">
          <Button
            onClick={handleDownload}
            size={isMain ? 'default' : 'sm'}
            className="flex-1 bg-indigo-600 hover:bg-indigo-500 text-white"
          >
            ↓ Download .md
          </Button>
          <Button
            onClick={onGenerateSummary}
            variant="outline"
            size={isMain ? 'default' : 'sm'}
            disabled={isGeneratingSummary}
            className="border-gray-600 text-gray-300 hover:bg-gray-800"
          >
            Regenerate
          </Button>
        </div>
      ) : (
        !isCapturing &&
        hasMeetingData && (
          <Button
            onClick={onGenerateSummary}
            disabled={isGeneratingSummary}
            variant="outline"
            size={isMain ? 'default' : 'sm'}
            className="border-gray-600 text-gray-300 hover:bg-gray-800 w-full"
          >
            {isGeneratingSummary ? (
              <span className="animate-pulse">Generating final summary...</span>
            ) : (
              '📋 Generate Final Summary'
            )}
          </Button>
        )
      )}
    </div>
  );
}
