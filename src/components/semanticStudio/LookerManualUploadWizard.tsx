import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ArrowLeft, ArrowRight, CheckCircle2, ExternalLink, FileCode2, FlaskConical, Loader2, Trash2, Upload } from 'lucide-react';
import type { LookerRoundTripReport } from '@/services/semanticMigration/lookerRoundTrip';
import type { LookerManualParseResult, MigrationArtifact } from '@/services/semanticMigration/types';

type Step = 'add' | 'review' | 'ready';

function StepPill({ active, complete, label }: { active: boolean; complete: boolean; label: string }) {
  return <div className={`flex flex-1 items-center gap-2 border-b-2 px-2 py-2 text-xs font-semibold ${active ? 'border-omni-500 text-omni-700' : complete ? 'border-green-400 text-green-700' : 'border-border text-content-tertiary'}`}>
    {complete ? <CheckCircle2 size={14} /> : <span className={`h-2 w-2 rounded-full ${active ? 'bg-omni-500' : 'bg-border'}`} />}
    <span>{label}</span>
  </div>;
}

function Benchmark({ report }: { report: LookerRoundTripReport }) {
  return <div className={`rounded-button border p-3 ${report.meetsTarget ? 'border-green-200 bg-green-50' : 'border-amber-200 bg-amber-50'}`}>
    <div className="flex items-center justify-between gap-3">
      <div><div className="text-xs font-semibold">Whataburger LookML benchmark</div><div className="mt-1 text-[11px] text-content-secondary">{report.summary}</div></div>
      <div className={`text-2xl font-semibold ${report.meetsTarget ? 'text-green-800' : 'text-amber-900'}`}>{report.score}%</div>
    </div>
    <div className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-3">
      {report.categories.map((category) => <div key={category.category} className="text-[10px] text-content-secondary"><span>{category.label}</span><span className="float-right font-semibold text-content-primary">{category.matchedCount}/{category.expectedCount}</span></div>)}
    </div>
    <div className="mt-2 text-[10px] text-content-secondary">{report.caveat}</div>
  </div>;
}

export function LookerManualUploadWizard({
  artifacts, result, status, error, onFiles, onRemove, onClear, onReadyChange, onLoadExample, exampleLoading, exampleReport,
}: {
  artifacts: MigrationArtifact[];
  result: LookerManualParseResult | null;
  status: 'idle' | 'parsing' | 'ready' | 'failed';
  error: string;
  onFiles: (files: FileList | null) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
  onReadyChange: (ready: boolean) => void;
  onLoadExample: () => void;
  exampleLoading: boolean;
  exampleReport: LookerRoundTripReport | null;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<Step>('add');
  const [acknowledged, setAcknowledged] = useState(false);
  const hasModel = (result?.diagnostics.modelFileCount || 0) > 0;
  const hasViews = (result?.inventory.views.length || 0) > 0;
  const hasDashboard = (result?.inventory.dashboards.length || 0) > 0;
  const unsupported = result?.diagnostics.unsupportedArtifactCount || 0;
  const ready = status === 'ready' && hasModel && hasViews && hasDashboard && (unsupported === 0 || acknowledged);
  const fileReviews = useMemo(() => artifacts.map((artifact) => ({
    ...artifact,
    mappingCount: result?.mappings.filter((mapping) => mapping.sourceArtifact === artifact.name).length || 0,
  })), [artifacts, result]);

  useEffect(() => { onReadyChange(step === 'ready' && ready); }, [onReadyChange, ready, step]);
  useEffect(() => { setAcknowledged(false); if (artifacts.length === 0) setStep('add'); }, [artifacts]);

  return <div className="space-y-4">
    <div className="flex"><StepPill label="1. Add project files" active={step === 'add'} complete={step !== 'add'} /><StepPill label="2. Review evidence" active={step === 'review'} complete={step === 'ready'} /><StepPill label="3. Ready" active={step === 'ready'} complete={step === 'ready' && ready} /></div>
    <div className="rounded-button border border-blue-200 bg-blue-50 p-3 text-xs text-blue-900">
      Upload the LookML project together: at least one <code>.model.lkml</code>, its included <code>.view.lkml</code> files, and the relevant <code>.dashboard.lookml</code> files. OmniKit keeps PDT and access-filter behavior visible for human review.
      <a className="ml-2 inline-flex items-center gap-1 font-semibold underline" href="https://docs.cloud.google.com/looker/docs/lookml-project-files" target="_blank" rel="noreferrer">Looker file docs <ExternalLink size={11} /></a>
    </div>

    {step === 'add' && <div className="space-y-3">
      <input ref={inputRef} type="file" multiple accept=".lkml,.lookml" className="hidden" onChange={(event) => onFiles(event.target.files)} />
      <div className="grid gap-2 sm:grid-cols-2">
        <button type="button" onClick={() => inputRef.current?.click()} className="btn-secondary justify-center text-sm"><Upload size={14} />Upload LookML project files</button>
        <button type="button" onClick={onLoadExample} disabled={exampleLoading} className="btn-secondary justify-center text-sm disabled:opacity-60">{exampleLoading ? <Loader2 size={14} className="animate-spin" /> : <FlaskConical size={14} />}Load Whataburger Looker example</button>
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        {[['Model', hasModel, 'Connection, includes, Explores'], ['Views', hasViews, 'Dimensions and measures'], ['Dashboard', hasDashboard, 'Tiles, fields, filters, listen']].map(([label, found, detail]) => <div key={String(label)} className={`rounded-button border p-3 ${found ? 'border-green-200 bg-green-50' : 'border-border bg-surface-secondary'}`}><div className="text-xs font-semibold">{String(label)} {found ? 'found' : 'needed'}</div><div className="mt-1 text-[11px] text-content-secondary">{String(detail)}</div></div>)}
      </div>
      {artifacts.length > 0 && <button type="button" onClick={() => setStep('review')} className="btn-primary w-full justify-center text-sm" disabled={status === 'parsing'}>{status === 'parsing' ? <Loader2 size={14} className="animate-spin" /> : <ArrowRight size={14} />}Review parsed evidence</button>}
    </div>}

    {step === 'review' && <div className="space-y-3">
      {status === 'failed' && <div className="rounded-button border border-red-200 bg-red-50 p-3 text-xs text-red-700">
        <div>{error}</div>
        {/vault locked/i.test(error) && <a href="/" target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 font-semibold underline">Unlock vault in a new tab <ExternalLink size={11} /></a>}
      </div>}
      {fileReviews.map((artifact) => <div key={artifact.id} className="flex items-center justify-between gap-3 rounded-button border border-border p-3"><div className="min-w-0"><div className="truncate text-xs font-semibold"><FileCode2 size={13} className="mr-1 inline" />{artifact.name}</div><div className="mt-1 text-[11px] text-content-secondary">{artifact.mappingCount ? `${artifact.mappingCount} normalized mapping${artifact.mappingCount === 1 ? '' : 's'}` : 'No supported LookML evidence found'}</div></div><button type="button" aria-label={`Remove ${artifact.name}`} onClick={() => onRemove(artifact.id)} className="icon-btn"><Trash2 size={14} /></button></div>)}
      {result && <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">{[['Views', result.inventory.views.length], ['Measures', result.inventory.metrics.length], ['Explores', result.inventory.explores.length], ['Joins', result.inventory.relationships.length], ['Dashboards', result.inventory.dashboards.length], ['Warnings', result.inventory.warnings.length]].map(([label, count]) => <div key={String(label)} className="rounded-button border border-border p-2"><div className="text-lg font-semibold">{count}</div><div className="text-[10px] text-content-secondary">{label}</div></div>)}</div>}
      {result?.inventory.warnings.map((warning) => <div key={warning} className="flex gap-2 rounded-button border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-900"><AlertTriangle size={13} className="mt-0.5 shrink-0" />{warning}</div>)}
      {unsupported > 0 && <label className="flex gap-2 text-xs text-content-secondary"><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />Continue without evidence from {unsupported} unsupported file{unsupported === 1 ? '' : 's'}.</label>}
      {exampleReport && <Benchmark report={exampleReport} />}
      <div className="flex gap-2"><button type="button" onClick={() => setStep('add')} className="btn-secondary text-sm"><ArrowLeft size={14} />Back</button><button type="button" onClick={() => setStep('ready')} disabled={!ready} className="btn-primary flex-1 justify-center text-sm disabled:opacity-50"><CheckCircle2 size={14} />Confirm LookML inventory</button></div>
    </div>}

    {step === 'ready' && <div className="space-y-3">
      <div className="rounded-button border border-green-200 bg-green-50 p-4 text-sm text-green-800"><div className="font-semibold">LookML project ready for migration planning</div><div className="mt-1 text-xs">OmniKit will send normalized semantic evidence to the selected AI option. Raw files remain transient, and no target model changes occur until reviewed deliverables are saved to a branch.</div></div>
      {exampleReport && <Benchmark report={exampleReport} />}
      <div className="flex gap-2"><button type="button" onClick={() => setStep('review')} className="btn-secondary text-sm"><ArrowLeft size={14} />Review again</button><button type="button" onClick={onClear} className="btn-secondary text-sm"><Trash2 size={14} />Start over</button></div>
    </div>}
  </div>;
}
