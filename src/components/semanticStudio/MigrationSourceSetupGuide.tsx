import { useEffect, useMemo, useState } from 'react';
import { BookOpen, CheckCircle2, ExternalLink, FileArchive, KeyRound, ShieldCheck } from 'lucide-react';
import { AdvancedDisclosure } from '@/components/ui/AdvancedDisclosure';
import { ComboBox } from '@/components/ui/ComboBox';
import {
  MIGRATION_SOURCE_SETUP_OPTIONS,
  migrationSourceSetupGuide,
  type MigrationSourceSetupMode,
} from '@/services/semanticMigration/sourceSetupGuidance';
import type { MigrationBiSourceTool } from '@/services/semanticMigration/types';

interface MigrationSourceSetupGuideProps {
  source: MigrationBiSourceTool;
  mode: MigrationSourceSetupMode;
}

export function MigrationSourceSetupGuide({ source, mode }: MigrationSourceSetupGuideProps) {
  const [selectedSource, setSelectedSource] = useState<MigrationBiSourceTool>(source);
  const [selectedMode, setSelectedMode] = useState<MigrationSourceSetupMode>(mode);

  useEffect(() => {
    setSelectedSource(source);
  }, [source]);

  useEffect(() => {
    setSelectedMode(mode);
  }, [mode]);

  const guide = useMemo(() => migrationSourceSetupGuide(selectedSource), [selectedSource]);
  const effectiveMode: MigrationSourceSetupMode = selectedMode === 'api' && guide.api ? 'api' : 'manual';
  const path = effectiveMode === 'api' ? guide.api! : guide.manual;

  function changeSource(value: string) {
    const nextSource = value as MigrationBiSourceTool;
    const nextGuide = migrationSourceSetupGuide(nextSource);
    setSelectedSource(nextSource);
    if (!nextGuide.api) setSelectedMode('manual');
  }

  return (
    <div data-testid="migration-source-setup-guide">
      <AdvancedDisclosure
        title={<span className="inline-flex items-center gap-2"><BookOpen size={16} className="text-omni-700" /> Source setup guide</span>}
        description="Choose a source for step-by-step Saved API access or Manual Files instructions."
        className="bg-white"
        contentClassName="space-y-4"
        lazyReadOnly
      >
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(260px,0.8fr)] md:items-end">
          <label className="text-xs font-semibold text-content-secondary">
            Source platform
            <div className="mt-1" data-testid="migration-source-setup-guide-picker">
              <ComboBox
                ariaLabel="Setup guide source platform"
                value={selectedSource}
                onChange={changeSource}
                options={MIGRATION_SOURCE_SETUP_OPTIONS}
                placeholder="Choose a source guide"
                allowFreeText={false}
              />
            </div>
          </label>
          <div>
            <div className="text-xs font-semibold text-content-secondary">Acquisition method</div>
            <div className="mt-1 grid grid-cols-2 rounded-button border border-border bg-white p-1" role="group" aria-label="Setup guide acquisition method">
              <button
                type="button"
                data-testid="migration-source-setup-method-api"
                aria-pressed={effectiveMode === 'api'}
                disabled={!guide.api}
                onClick={() => setSelectedMode('api')}
                className={`rounded-button px-2 py-2 text-xs font-semibold ${effectiveMode === 'api' ? 'bg-omni-700 text-white' : 'text-content-secondary hover:bg-surface-secondary'} disabled:cursor-not-allowed disabled:opacity-45`}
              >
                Saved API
              </button>
              <button
                type="button"
                data-testid="migration-source-setup-method-manual"
                aria-pressed={effectiveMode === 'manual'}
                onClick={() => setSelectedMode('manual')}
                className={`rounded-button px-2 py-2 text-xs font-semibold ${effectiveMode === 'manual' ? 'bg-omni-700 text-white' : 'text-content-secondary hover:bg-surface-secondary'}`}
              >
                Manual files
              </button>
            </div>
          </div>
        </div>

        <section
          key={`${selectedSource}-${effectiveMode}`}
          role="region"
          aria-label={`${guide.label} ${effectiveMode === 'api' ? 'Saved API' : 'Manual Files'} setup`}
          data-testid={`source-setup-${effectiveMode}-${selectedSource}`}
          className="overflow-hidden rounded-card border border-border bg-white"
        >
          <div className="border-b border-border bg-surface-secondary px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-omni-700">{guide.label} · {guide.availabilityLabel}</div>
                <h3 className="mt-1 text-base font-semibold text-content-primary">{path.title}</h3>
              </div>
              <span className={`rounded-chip px-2 py-1 text-[10px] font-semibold ${effectiveMode === 'api' ? 'bg-blue-100 text-blue-800' : 'bg-amber-100 text-amber-900'}`}>
                {effectiveMode === 'api' ? 'Read-only API' : guide.api ? 'Manual fallback' : 'Manual Files only'}
              </span>
            </div>
            <p className="mt-2 max-w-4xl text-xs leading-relaxed text-content-secondary">{path.summary}</p>
          </div>

          <div className="grid gap-5 px-4 py-4 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
            <div className="space-y-4">
              <div>
                <div className="flex items-center gap-2 text-xs font-semibold text-content-primary"><ShieldCheck size={14} className="text-green-700" /> Before you begin</div>
                <ul className="mt-2 space-y-1.5 text-xs leading-relaxed text-content-secondary">
                  {path.prerequisites.map((item) => <li key={item} className="flex gap-2"><span aria-hidden="true" className="text-omni-700">•</span><span>{item}</span></li>)}
                </ul>
              </div>

              {path.fields && (
                <div className="rounded-button border border-blue-200 bg-blue-50 px-3 py-3">
                  <div className="flex items-center gap-2 text-xs font-semibold text-blue-950"><KeyRound size={14} /> Enter these fields in OmniKit</div>
                  <ul className="mt-2 space-y-1 text-xs text-blue-950">
                    {path.fields.map((field) => <li key={field}>• {field}</li>)}
                  </ul>
                </div>
              )}

              {path.acceptedArtifacts && (
                <div className="rounded-button border border-amber-200 bg-amber-50 px-3 py-3">
                  <div className="flex items-center gap-2 text-xs font-semibold text-amber-950"><FileArchive size={14} /> Accepted files</div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {path.acceptedArtifacts.map((artifact) => <code key={artifact} className="rounded-chip border border-amber-200 bg-white px-2 py-0.5 text-[10px] text-amber-950">{artifact}</code>)}
                  </div>
                </div>
              )}
            </div>

            <div>
              <div className="text-xs font-semibold text-content-primary">Step-by-step setup</div>
              <ol className="mt-2 space-y-2.5">
                {path.steps.map((step, index) => (
                  <li key={step} className="flex gap-3 text-xs leading-relaxed text-content-secondary">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-omni-700 text-[10px] font-bold text-white">{index + 1}</span>
                    <span className="pt-0.5">{step}</span>
                  </li>
                ))}
              </ol>
            </div>
          </div>

          <div className="grid border-t border-border lg:grid-cols-2 lg:divide-x lg:divide-border">
            <div className="px-4 py-4">
              <div className="flex items-center gap-2 text-xs font-semibold text-green-800"><CheckCircle2 size={14} /> What OmniKit can collect</div>
              <ul className="mt-2 space-y-1.5 text-xs leading-relaxed text-content-secondary">
                {path.collects.map((item) => <li key={item}>• {item}</li>)}
              </ul>
            </div>
            <div className="border-t border-border px-4 py-4 lg:border-t-0">
              <div className="text-xs font-semibold text-amber-900">What still requires review or Manual Files</div>
              <ul className="mt-2 space-y-1.5 text-xs leading-relaxed text-content-secondary">
                {path.boundaries.map((item) => <li key={item}>• {item}</li>)}
              </ul>
            </div>
          </div>

          <div className="border-t border-border bg-blue-50/60 px-4 py-4">
            <div className="text-xs font-semibold text-blue-950">Official setup documentation</div>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
              {path.documentation.map((document) => (
                <a key={document.url} className="inline-flex items-center gap-1 text-xs font-semibold text-blue-800 underline" href={document.url} target="_blank" rel="noreferrer">
                  {document.title}<ExternalLink size={11} />
                </a>
              ))}
            </div>
            <p className="mt-3 text-[11px] leading-relaxed text-blue-950">
              {effectiveMode === 'api'
                ? 'Use a dedicated least-privilege identity. OmniKit encrypts saved credentials in the local vault and never returns secret values to this guide.'
                : 'Manual uploads remain transient in the browser workflow. Remove credentials, tokens, and unnecessary user identity data before uploading.'}
            </p>
          </div>
        </section>
      </AdvancedDisclosure>
    </div>
  );
}
