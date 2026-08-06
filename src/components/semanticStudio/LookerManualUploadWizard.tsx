import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ArrowLeft, ArrowRight, CheckCircle2, ExternalLink, FileCode2, Loader2, Trash2, Upload } from 'lucide-react';
import { lookerManualUploadGate } from '@/services/semanticMigration/manualUpload';
import type { LookerManualParseResult, MigrationArtifact } from '@/services/semanticMigration/types';

type Step = 'add' | 'review' | 'ready';

function StepPill({ active, complete, label }: { active: boolean; complete: boolean; label: string }) {
  return <div className={`flex flex-1 items-center gap-2 border-b-2 px-2 py-2 text-xs font-semibold ${active ? 'border-omni-500 text-omni-700' : complete ? 'border-green-400 text-green-700' : 'border-border text-content-tertiary'}`}>
    {complete ? <CheckCircle2 size={14} /> : <span className={`h-2 w-2 rounded-full ${active ? 'bg-omni-500' : 'bg-border'}`} />}
    <span>{label}</span>
  </div>;
}

export function LookerManualUploadWizard({
  artifacts, result, status, error, onFiles, onRemove, onClear, onReadyChange,
}: {
  artifacts: MigrationArtifact[];
  result: LookerManualParseResult | null;
  status: 'idle' | 'parsing' | 'ready' | 'failed';
  error: string;
  onFiles: (files: FileList | null) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
  onReadyChange: (ready: boolean) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<Step>('add');
  const [acknowledged, setAcknowledged] = useState(false);
  const hasModel = (result?.diagnostics.modelFileCount || 0) > 0;
  const hasViews = (result?.inventory.views.length || 0) > 0;
  const hasExplores = (result?.inventory.explores.length || 0) > 0;
  const hasDashboard = (result?.inventory.dashboards.length || 0) > 0;
  const unsupported = result?.diagnostics.unsupportedArtifactCount || 0;
  const gate = lookerManualUploadGate({ result, unsupportedAcknowledged: acknowledged });
  const ready = status === 'ready' && gate.ready;
  const fileReviews = useMemo(() => artifacts.map((artifact) => ({
    ...artifact,
    mappingCount: result?.mappings.filter((mapping) => mapping.sourceArtifact === artifact.name).length || 0,
    isRefinement: /\b(?:view|explore)\s*:\s*\+[\w.]+\s*\{/i.test(artifact.content),
  })), [artifacts, result]);
  const parserWarnings = result?.inventory.warnings || [];
  const visibleWarnings = parserWarnings.slice(0, 6);
  const remainingWarnings = parserWarnings.slice(6);

  useEffect(() => { onReadyChange(step === 'ready' && ready); }, [onReadyChange, ready, step]);
  useEffect(() => { setAcknowledged(false); if (artifacts.length === 0) setStep('add'); }, [artifacts]);

  return <div className="space-y-4">
    <div className="flex"><StepPill label="1. Add project files" active={step === 'add'} complete={step !== 'add'} /><StepPill label="2. Review evidence" active={step === 'review'} complete={step === 'ready'} /><StepPill label="3. Ready" active={step === 'ready'} complete={step === 'ready' && ready} /></div>
    <div className="rounded-button border border-blue-200 bg-blue-50 p-3 text-xs text-blue-900">
      Upload the LookML files in scope. Views or Explores are sufficient for semantic-only planning; add <code>.model.lkml</code> and <code>.dashboard.lookml</code> files when available to cover model settings and dashboard behavior. Add an explicit <code>.look.json</code> companion export when dashboard tiles reference saved Looks. OmniKit keeps PDT and access-filter behavior, data actions, and access-control dependencies visible for human review.
      <a className="ml-2 inline-flex items-center gap-1 font-semibold underline" href="https://docs.cloud.google.com/looker/docs/lookml-project-files" target="_blank" rel="noreferrer">Looker file docs <ExternalLink size={11} /></a>
    </div>

    {step === 'add' && <div className="space-y-3">
      <input ref={inputRef} type="file" multiple accept=".lkml,.lookml,.look.json,.looks.json" className="hidden" onChange={(event) => onFiles(event.target.files)} />
      <button type="button" onClick={() => inputRef.current?.click()} className="btn-primary w-full justify-center text-sm"><Upload size={14} />Upload LookML project</button>
      <div className="grid gap-2 sm:grid-cols-3">
        {[
          ['Model', hasModel, 'Connection, includes, access behavior', 'recommended'],
          ['Semantic', hasViews || hasExplores, 'Views, fields, measures, Explores', 'needed'],
          ['Dashboard', hasDashboard, 'Tiles, fields, filters, listeners', 'optional'],
        ].map(([label, found, detail, missingLabel]) => <div key={String(label)} className={`rounded-button border p-3 ${found ? 'border-green-200 bg-green-50' : 'border-border bg-surface-secondary'}`}><div className="text-xs font-semibold">{String(label)} {found ? 'found' : missingLabel}</div><div className="mt-1 text-[11px] text-content-secondary">{String(detail)}</div></div>)}
      </div>
      {artifacts.length > 0 && <button type="button" onClick={() => setStep('review')} className="btn-primary w-full justify-center text-sm" disabled={status === 'parsing'}>{status === 'parsing' ? <Loader2 size={14} className="animate-spin" /> : <ArrowRight size={14} />}Review parsed evidence</button>}
    </div>}

    {step === 'review' && <div className="space-y-3">
      {status === 'failed' && <div className="rounded-button border border-red-200 bg-red-50 p-3 text-xs text-red-700">
        <div>{error}</div>
        {/vault locked/i.test(error) && <a href="/" target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 font-semibold underline">Unlock vault in a new tab <ExternalLink size={11} /></a>}
      </div>}
      <details className="rounded-button border border-border bg-surface-secondary" open={fileReviews.length <= 12 ? true : undefined}>
        <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-content-primary">Review {fileReviews.length} source file{fileReviews.length === 1 ? '' : 's'}</summary>
        <div className="max-h-80 space-y-2 overflow-auto border-t border-border bg-white p-3">
          {fileReviews.map((artifact) => <div key={artifact.id} className="flex items-center justify-between gap-3 rounded-button border border-border p-3"><div className="min-w-0"><div className="truncate text-xs font-semibold"><FileCode2 size={13} className="mr-1 inline" />{artifact.name}</div><div className="mt-1 text-[11px] text-content-secondary">{artifact.mappingCount ? `${artifact.mappingCount} normalized mapping${artifact.mappingCount === 1 ? '' : 's'}` : artifact.isRefinement ? 'Recognized LookML refinement applied to its base object' : 'No supported LookML evidence found'}</div></div><button type="button" aria-label={`Remove ${artifact.name}`} onClick={() => onRemove(artifact.id)} className="icon-btn"><Trash2 size={14} /></button></div>)}
        </div>
      </details>
      {result && <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">{[['Views', result.inventory.views.length], ['Measures', result.inventory.metrics.length], ['Explores', result.inventory.explores.length], ['Joins', result.inventory.relationships.length], ['Dashboards', result.inventory.dashboards.length], ['Warnings', result.inventory.warnings.length]].map(([label, count]) => <div key={String(label)} className="rounded-button border border-border p-2"><div className="text-lg font-semibold">{count}</div><div className="text-[10px] text-content-secondary">{label}</div></div>)}</div>}
      {parserWarnings.length > 0 && <div className="rounded-button border border-amber-200 bg-amber-50 p-3 text-amber-900">
        <div className="flex items-center gap-2 text-xs font-semibold"><AlertTriangle size={13} />{parserWarnings.length} parser warning{parserWarnings.length === 1 ? '' : 's'} need review</div>
        <ul className="mt-2 list-disc space-y-1 pl-4 text-[11px]">{visibleWarnings.map((warning, index) => <li key={`${index}:${warning}`}>{warning}</li>)}</ul>
        {remainingWarnings.length > 0 && <details className="mt-2 text-[11px]"><summary className="cursor-pointer font-semibold">Review {remainingWarnings.length} more warning{remainingWarnings.length === 1 ? '' : 's'}</summary><ul className="mt-2 max-h-56 list-disc space-y-1 overflow-auto pl-4">{remainingWarnings.map((warning, index) => <li key={`${index + visibleWarnings.length}:${warning}`}>{warning}</li>)}</ul></details>}
      </div>}
      {gate.reasons.filter((reason) => !/unsupported files/i.test(reason)).map((reason) => <div key={reason} className="flex gap-2 rounded-button border border-red-200 bg-red-50 p-2 text-[11px] text-red-800"><AlertTriangle size={13} className="mt-0.5 shrink-0" />{reason}</div>)}
      {unsupported > 0 && <label className="flex gap-2 text-xs text-content-secondary"><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />Continue without evidence from {unsupported} unsupported file{unsupported === 1 ? '' : 's'}.</label>}
      <div className="flex gap-2"><button type="button" onClick={() => setStep('add')} className="btn-secondary text-sm"><ArrowLeft size={14} />Back</button><button type="button" onClick={() => setStep('ready')} disabled={!ready} className="btn-primary flex-1 justify-center text-sm disabled:opacity-50"><CheckCircle2 size={14} />Confirm LookML inventory</button></div>
    </div>}

    {step === 'ready' && <div className="space-y-3">
      <div className="rounded-button border border-green-200 bg-green-50 p-4 text-sm text-green-800"><div className="font-semibold">{gate.semanticOnly ? 'Semantic-only LookML evidence ready' : 'LookML evidence ready for migration planning'}</div><div className="mt-1 text-xs">{gate.semanticOnly ? 'No source dashboards are in scope, so dashboard selection and construction are not required. ' : ''}OmniKit will send normalized semantic evidence to the selected AI option. Raw files remain transient, and no target model changes occur until reviewed deliverables are saved to a branch.</div></div>
      <div className="flex gap-2"><button type="button" onClick={() => setStep('review')} className="btn-secondary text-sm"><ArrowLeft size={14} />Review again</button><button type="button" onClick={onClear} className="btn-secondary text-sm"><Trash2 size={14} />Start over</button></div>
    </div>}
  </div>;
}
