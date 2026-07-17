import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ExternalLink,
  FileText,
  Loader2,
  Trash2,
  Upload,
} from 'lucide-react';
import {
  buildDomoManualArtifactReview,
  DOMO_MANUAL_ROLE_LABELS,
  domoManualUploadGate,
  type DomoManualUploadStep,
} from '@/services/semanticMigration/manualUpload';
import type { DomoManualParseResult, DomoManualSourceKind, MigrationArtifact } from '@/services/semanticMigration/types';

const EVIDENCE_GUIDE: Array<{ kind: DomoManualSourceKind; title: string; description: string; required: boolean }> = [
  { kind: 'dataset_schema', title: 'Dataset schemas', description: 'Column names, data types, and dataset IDs for shared Omni views.', required: true },
  { kind: 'beast_mode', title: 'Beast Modes', description: 'Calculated fields to translate into reviewed shared measures.', required: false },
  { kind: 'dataflow_sql', title: 'SQL DataFlows', description: 'SQL transforms and joins for query views and relationships.', required: false },
  { kind: 'card', title: 'Card definitions', description: 'Dataset, fields, filters, and chart intent for dashboard tiles.', required: true },
];

function StepPill({ active, complete, label }: { active: boolean; complete: boolean; label: string }) {
  return (
    <div className={`flex min-w-0 flex-1 items-center gap-2 border-b-2 px-2 py-2 text-xs font-semibold ${active ? 'border-omni-500 text-omni-700' : complete ? 'border-green-400 text-green-700' : 'border-border text-content-tertiary'}`}>
      {complete ? <CheckCircle2 size={14} /> : <span className={`h-2 w-2 rounded-full ${active ? 'bg-omni-500' : 'bg-border'}`} />}
      <span className="truncate">{label}</span>
    </div>
  );
}

function mappingCount(result: DomoManualParseResult | null, kinds: DomoManualSourceKind[]) {
  return result?.mappings.filter((mapping) => kinds.includes(mapping.sourceKind)).length || 0;
}

export function DomoManualUploadWizard({
  artifacts,
  result,
  status,
  error,
  onFiles,
  onAddPasted,
  onRemove,
  onClear,
  onReadyChange,
}: {
  artifacts: MigrationArtifact[];
  result: DomoManualParseResult | null;
  status: 'idle' | 'parsing' | 'ready' | 'failed';
  error: string;
  onFiles: (files: FileList | null) => void;
  onAddPasted: (name: string, content: string) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
  onReadyChange: (ready: boolean) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<DomoManualUploadStep>('add');
  const [pasteName, setPasteName] = useState('pasted-domo.json');
  const [pasteText, setPasteText] = useState('');
  const [conflictsAcknowledged, setConflictsAcknowledged] = useState(false);
  const [unsupportedAcknowledged, setUnsupportedAcknowledged] = useState(false);
  const artifactSignature = useMemo(() => artifacts.map((artifact) => artifact.id).join('|'), [artifacts]);
  const reviews = useMemo(() => buildDomoManualArtifactReview(artifacts, result), [artifacts, result]);
  const gate = domoManualUploadGate({ result, conflictsAcknowledged, unsupportedAcknowledged });

  useEffect(() => {
    setStep('add');
    setConflictsAcknowledged(false);
    setUnsupportedAcknowledged(false);
    onReadyChange(false);
  }, [artifactSignature, onReadyChange]);

  function addPastedSource() {
    if (!pasteText.trim()) return;
    onAddPasted(pasteName.trim() || 'pasted-domo.json', pasteText);
    setPasteText('');
  }

  function confirmInventory() {
    if (!gate.ready) return;
    setStep('ready');
    onReadyChange(true);
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-2" aria-label="Manual Domo upload progress">
        <StepPill label="1. Add files" active={step === 'add'} complete={step !== 'add'} />
        <StepPill label="2. Review evidence" active={step === 'review'} complete={step === 'ready'} />
        <StepPill label="3. Ready" active={step === 'ready'} complete={false} />
      </div>

      {step === 'add' && (
        <div className="space-y-4">
          <div>
            <div className="text-xs font-semibold text-content-primary">Build the Domo evidence bundle</div>
            <div className="mt-1 text-[11px] leading-relaxed text-content-secondary">Upload related exports together. OmniKit combines repeated dashboard dependencies additively and will show exactly what it recognized before planning.</div>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {EVIDENCE_GUIDE.map((item) => {
              const detected = mappingCount(result, item.kind === 'dataflow_sql' ? ['dataflow_sql', 'relationship'] : [item.kind]);
              return (
                <div key={item.kind} className="rounded-button border border-border bg-surface-secondary px-3 py-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-content-primary">{item.title}</span>
                    <span className={`rounded-chip px-1.5 py-0.5 text-[9px] font-semibold ${detected > 0 ? 'bg-green-50 text-green-700' : 'bg-white text-content-tertiary'}`}>{detected > 0 ? `${detected} found` : item.required ? 'Required' : 'When used'}</span>
                  </div>
                  <div className="mt-1 text-[10px] leading-relaxed text-content-secondary">{item.description}</div>
                </div>
              );
            })}
          </div>

          <input ref={fileInputRef} type="file" multiple accept=".json,.sql,.txt,.md,.csv" className="hidden" onChange={(event) => { onFiles(event.target.files); event.target.value = ''; }} />
          <button type="button" onClick={() => fileInputRef.current?.click()} className="btn-primary w-full justify-center text-sm">
            <Upload size={14} />
            Add Domo exports
          </button>

          <details className="rounded-button border border-border bg-white px-3 py-2.5">
            <summary className="cursor-pointer text-xs font-semibold text-content-primary">Paste JSON, a Beast Mode, or DataFlow SQL</summary>
            <div className="mt-3 grid gap-2">
              <input value={pasteName} onChange={(event) => setPasteName(event.target.value)} className="input-field text-xs" placeholder="pasted-domo.json" />
              <textarea value={pasteText} onChange={(event) => setPasteText(event.target.value)} className="input-field min-h-[140px] resize-y font-mono text-xs" placeholder="Paste Domo JSON, a Beast Mode formula, or SQL DataFlow text..." spellCheck={false} />
              <button type="button" onClick={addPastedSource} disabled={!pasteText.trim()} className="btn-secondary justify-center text-sm disabled:cursor-not-allowed disabled:opacity-60">
                <FileText size={14} />
                Add pasted evidence
              </button>
            </div>
          </details>

          {artifacts.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-button border border-border bg-white px-3 py-2.5">
              <div className="text-xs text-content-secondary"><span className="font-semibold text-content-primary">{artifacts.length} file{artifacts.length === 1 ? '' : 's'}</span> in this upload bundle</div>
              <button type="button" onClick={onClear} className="btn-ghost px-2 py-1 text-xs text-red-700"><Trash2 size={13} /> Clear</button>
            </div>
          )}
          {status === 'parsing' && <div className="flex items-center gap-2 text-xs font-medium text-omni-700"><Loader2 size={14} className="animate-spin" /> Normalizing Domo evidence...</div>}
          {status === 'failed' && (
            <div className="rounded-button border border-red-200 bg-red-50 px-3 py-2.5 text-xs text-red-700">
              <div>{error || 'The Domo bundle could not be parsed.'}</div>
              {/vault locked/i.test(error) && (
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[11px] text-red-800">Keep this tab open so the uploaded files remain in memory.</span>
                  <a href="/" target="_blank" rel="noreferrer" className="btn-secondary px-2 py-1 text-xs">
                    Unlock vault in a new tab <ExternalLink size={12} />
                  </a>
                </div>
              )}
            </div>
          )}
          <button type="button" onClick={() => setStep('review')} disabled={status !== 'ready' || !result} className="btn-primary w-full justify-center text-sm disabled:cursor-not-allowed disabled:opacity-60">
            Review parsed evidence <ArrowRight size={14} />
          </button>
        </div>
      )}

      {step === 'review' && result && (
        <div className="space-y-4">
          <div>
            <div className="text-xs font-semibold text-content-primary">Review what OmniKit recognized</div>
            <div className="mt-1 text-[11px] leading-relaxed text-content-secondary">Files remain separate evidence sources. Shared formulas are deduplicated only when their formulas match; different formulas are preserved as additive candidates.</div>
          </div>
          <div className="divide-y divide-border overflow-hidden rounded-button border border-border bg-white">
            {reviews.map((review) => (
              <div key={review.artifactId} className="flex items-start justify-between gap-3 px-3 py-2.5">
                <div className="min-w-0">
                  <div className="truncate text-xs font-semibold text-content-primary">{review.name}</div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {review.roles.length > 0 ? review.roles.map((role) => <span key={role} className="rounded-chip bg-omni-50 px-1.5 py-0.5 text-[9px] font-semibold text-omni-700">{DOMO_MANUAL_ROLE_LABELS[role]}</span>) : <span className="text-[10px] text-amber-700">No supported Domo evidence detected</span>}
                  </div>
                </div>
                <button type="button" onClick={() => onRemove(review.artifactId)} className="btn-ghost shrink-0 p-1.5 text-content-tertiary" title={`Remove ${review.name}`} aria-label={`Remove ${review.name}`}><Trash2 size={14} /></button>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
            {[
              ['Dataset schemas', mappingCount(result, ['dataset_schema'])],
              ['Beast Modes', mappingCount(result, ['beast_mode'])],
              ['DataFlow actions', mappingCount(result, ['dataflow_sql', 'relationship'])],
              ['Cards', mappingCount(result, ['card'])],
            ].map(([label, count]) => <div key={String(label)} className="rounded-button border border-border bg-surface-secondary px-2.5 py-2"><div className="text-[10px] text-content-secondary">{label}</div><div className="mt-1 text-lg font-semibold text-content-primary">{count}</div></div>)}
          </div>


          {result.diagnostics.deduplicatedMeasureCount > 0 && (
            <div className="rounded-button border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-800">
              <span className="font-semibold">{result.diagnostics.deduplicatedMeasureCount} repeated Beast Mode reference{result.diagnostics.deduplicatedMeasureCount === 1 ? '' : 's'} consolidated.</span> The matching formula is represented once and remains linked to all uploaded evidence.
            </div>
          )}

          {result.conflicts.length > 0 && (
            <div className="rounded-button border border-amber-200 bg-amber-50 px-3 py-3">
              <div className="flex items-center gap-2 text-xs font-semibold text-amber-900"><AlertTriangle size={14} /> Different formulas share the same Beast Mode name</div>
              <div className="mt-1 text-[11px] text-amber-800">Nothing was overwritten. OmniKit preserved every formula with a distinct proposed name for the AI mapping review.</div>
              <div className="mt-3 space-y-2">
                {result.conflicts.map((conflict) => (
                  <div key={conflict.id} className="rounded-button bg-white px-2.5 py-2 text-[11px] text-content-secondary">
                    <div className="font-semibold text-content-primary">{conflict.datasetView} · {conflict.sourceName}</div>
                    <div className="mt-1 space-y-1 font-mono text-[10px]">{conflict.variants.map((variant) => <div key={variant.proposedName}>{variant.proposedName}</div>)}</div>
                  </div>
                ))}
              </div>
              <label className="mt-3 flex cursor-pointer items-start gap-2 text-[11px] text-amber-900"><input type="checkbox" className="mt-0.5" checked={conflictsAcknowledged} onChange={(event) => setConflictsAcknowledged(event.target.checked)} /><span>Keep every formula variant as an additive candidate for mapping or creation.</span></label>
            </div>
          )}

          {result.diagnostics.unsupportedArtifactCount > 0 && (
            <label className="flex cursor-pointer items-start gap-2 rounded-button border border-amber-200 bg-amber-50 px-3 py-2.5 text-[11px] text-amber-900"><input type="checkbox" className="mt-0.5" checked={unsupportedAcknowledged} onChange={(event) => setUnsupportedAcknowledged(event.target.checked)} /><span>{result.diagnostics.unsupportedArtifactCount} file{result.diagnostics.unsupportedArtifactCount === 1 ? '' : 's'} did not contribute supported Domo evidence. Continue without those files.</span></label>
          )}

          {gate.reasons.length > 0 && <div className="space-y-1 rounded-button border border-red-200 bg-red-50 px-3 py-2.5 text-[11px] text-red-700">{gate.reasons.map((reason) => <div key={reason}>• {reason}</div>)}</div>}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
            <button type="button" onClick={() => setStep('add')} className="btn-secondary justify-center text-sm"><ArrowLeft size={14} /> Add more files</button>
            <button type="button" onClick={confirmInventory} disabled={!gate.ready} className="btn-primary justify-center text-sm disabled:cursor-not-allowed disabled:opacity-60">Confirm upload inventory <ArrowRight size={14} /></button>
          </div>
        </div>
      )}

      {step === 'ready' && result && (
        <div className="space-y-3">
          <div className="rounded-button border border-green-200 bg-green-50 px-3 py-3">
            <div className="flex items-center gap-2 text-xs font-semibold text-green-800"><CheckCircle2 size={14} /> Domo evidence is ready for migration planning</div>
            <div className="mt-1 text-[11px] text-green-700">{result.inventory.summary}</div>
          </div>
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
            {[
              ['Shared views', mappingCount(result, ['dataset_schema'])],
              ['Shared measures', mappingCount(result, ['beast_mode'])],
              ['Query + relationships', mappingCount(result, ['dataflow_sql', 'relationship'])],
              ['Dashboard tiles', mappingCount(result, ['card'])],
            ].map(([label, count]) => <div key={String(label)} className="rounded-button border border-border bg-surface-secondary px-2.5 py-2"><div className="text-[10px] text-content-secondary">{label}</div><div className="mt-1 text-lg font-semibold text-content-primary">{count}</div></div>)}
          </div>
          <button type="button" onClick={() => { setStep('review'); onReadyChange(false); }} className="btn-secondary justify-center text-sm"><ArrowLeft size={14} /> Edit upload inventory</button>
        </div>
      )}
    </div>
  );
}
