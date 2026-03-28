'use client';

import type {
  FactCheckResult,
  FactCheckStatement,
  FactCheckStatementSource,
  FactCheckVerdict,
} from '@/types';
import { Button } from '@/components/ui/button';

interface Props {
  isCapturing: boolean;
  isRunning: boolean;
  error: string | null;
  claims: string[];
  statements?: FactCheckStatement[];
  results: FactCheckResult[];
  onRun: () => Promise<void>;
}

const verdictOrder: FactCheckVerdict[] = [
  'contradicted',
  'mixed',
  'supported',
  'insufficient_evidence',
];

const verdictLabel: Record<FactCheckVerdict, string> = {
  supported: 'Supported',
  contradicted: 'Contradicted',
  mixed: 'Mixed',
  insufficient_evidence: 'Insufficient Evidence',
};

const verdictClass: Record<FactCheckVerdict, string> = {
  supported: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200',
  contradicted: 'border-red-500/30 bg-red-500/10 text-red-200',
  mixed: 'border-amber-500/30 bg-amber-500/10 text-amber-200',
  insufficient_evidence: 'border-gray-600 bg-gray-800/60 text-gray-300',
};

const sourceLabel: Record<FactCheckStatementSource, string> = {
  visual: 'Visual',
  voice: 'Voice',
};

const sourceClass: Record<FactCheckStatementSource, string> = {
  visual: 'border-sky-500/30 bg-sky-500/10 text-sky-200',
  voice: 'border-violet-500/30 bg-violet-500/10 text-violet-200',
};

export default function FactCheckPanel({
  isCapturing,
  isRunning,
  error,
  claims,
  statements,
  results,
  onRun,
}: Props) {
  const normalizedStatements: FactCheckStatement[] =
    statements && statements.length > 0
      ? statements
      : claims.map((claim, index) => ({
          claim,
          source: 'visual',
          priority: index + 1,
        }));
  const visualStatements = normalizedStatements.filter((statement) => statement.source === 'visual');
  const voiceStatements = normalizedStatements.filter((statement) => statement.source === 'voice');

  return (
    <div className="p-3 space-y-3">
      <div className="space-y-1">
        <p className="text-xs text-gray-300 font-medium">Fact-check latest frame</p>
        <p className="text-xs text-gray-500">
          Railtracks now turns this into a real flow: extract claims, gather sources, judge each verdict, and retry weak results before showing them here.
        </p>
      </div>

      <Button
        onClick={onRun}
        disabled={!isCapturing || isRunning}
        variant="outline"
        size="sm"
        className="w-full border-gray-600 text-gray-200 hover:bg-gray-800"
      >
        {isRunning ? 'Fact-checking...' : 'Run Fact-check'}
      </Button>

      {!isCapturing && (
        <p className="text-xs text-gray-500">Start screen capture to run fact-checking.</p>
      )}

      {error && (
        <div className="rounded border border-red-500/30 bg-red-500/10 px-2.5 py-2 text-xs text-red-300">
          {error}
        </div>
      )}

      {normalizedStatements.length > 0 && (
        <div className="rounded border border-gray-700 bg-gray-800/40 p-2">
          <p className="text-[11px] uppercase tracking-wide text-gray-500 mb-2">
            Extracted statements
          </p>
          {visualStatements.length > 0 && (
            <div className="space-y-1.5 mb-2">
              <p className="text-[11px] text-sky-300">Visual</p>
              <ul className="space-y-1">
                {visualStatements.map((statement) => (
                  <li key={`visual-${statement.claim}`} className="text-xs text-gray-300 leading-snug">
                    - {statement.claim}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {voiceStatements.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[11px] text-violet-300">Voice</p>
              <ul className="space-y-1">
                {voiceStatements.map((statement) => (
                  <li key={`voice-${statement.claim}`} className="text-xs text-gray-300 leading-snug">
                    - {statement.claim}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {results.length > 0 ? (
        <div className="space-y-2">
          {verdictOrder.map((verdict) => {
            const group = results.filter((item) => item.verdict === verdict);
            if (!group.length) return null;
            return (
              <div key={verdict} className="space-y-1.5">
                <p className="text-[11px] uppercase tracking-wide text-gray-500">{verdictLabel[verdict]}</p>
                {group.map((item, index) => (
                  <div
                    key={`${item.claim}-${index}`}
                    className={`rounded border px-2.5 py-2 text-xs space-y-1.5 ${verdictClass[item.verdict]}`}
                  >
                    <span
                      className={`inline-flex rounded px-1.5 py-0.5 text-[10px] border ${sourceClass[item.source]}`}
                    >
                      {sourceLabel[item.source]}
                    </span>
                    <p className="font-medium">{item.claim}</p>
                    <p className="leading-snug">{item.summary}</p>
                    {item.sources.length > 0 && (
                      <div className="space-y-1">
                        {item.sources.slice(0, 3).map((source) => (
                          <a
                            key={`${source.url}-${source.title}`}
                            href={source.url}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="block underline underline-offset-2"
                          >
                            {source.title}
                          </a>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="text-xs text-gray-500">
          No fact-check results yet. Run it to get verdicts and source links.
        </p>
      )}
    </div>
  );
}
