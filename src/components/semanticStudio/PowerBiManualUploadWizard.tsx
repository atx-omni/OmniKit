import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ArrowLeft, ArrowRight, CheckCircle2, ExternalLink, FileJson2, Loader2, ShieldCheck, Trash2, Upload } from 'lucide-react';
import type { MigrationEngineBridgeResult } from '@/services/semanticMigration/engineBridge';
import { semanticMigrationAiEvidenceSummary } from '@/services/semanticMigration/prompts';
import type { MigrationArtifact, PowerBiManualParseResult } from '@/services/semanticMigration/types';

type Step = 'add' | 'review' | 'ready';

function StepPill({ active, complete, label }: { active: boolean; complete: boolean; label: string }) {
  return <div className={`flex flex-1 items-center gap-2 border-b-2 px-2 py-2 text-xs font-semibold ${active ? 'border-omni-500 text-omni-700' : complete ? 'border-green-400 text-green-700' : 'border-border text-content-tertiary'}`}>
    {complete ? <CheckCircle2 size={14} /> : <span className={`h-2 w-2 rounded-full ${active ? 'bg-omni-500' : 'bg-border'}`} />}
    <span>{label}</span>
  </div>;
}

export function PowerBiManualUploadWizard({
  artifacts, result, status, error, binaryArtifacts, engineResult, engineStatus, engineError, onFiles, onRemove, onBinaryRemove, onClear, onReadyChange, rawSourceEnabled, onRawSourceEnabledChange, providerLabel,
}: {
  artifacts: MigrationArtifact[];
  result: PowerBiManualParseResult | null;
  status: 'idle' | 'parsing' | 'ready' | 'failed';
  error: string;
  binaryArtifacts: Array<{ name: string; sizeBytes: number }>;
  engineResult: MigrationEngineBridgeResult | null;
  engineStatus: 'idle' | 'checking' | 'analyzing' | 'ready' | 'fallback';
  engineError: string;
  onFiles: (files: FileList | null) => void;
  onRemove: (id: string) => void;
  onBinaryRemove: (name: string) => void;
  onClear: () => void;
  onReadyChange: (ready: boolean) => void;
  rawSourceEnabled: boolean;
  onRawSourceEnabledChange: (enabled: boolean) => void;
  providerLabel: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<Step>('add');
  const [exceptionsAcknowledged, setExceptionsAcknowledged] = useState(false);
  const diagnostics = result?.diagnostics;
  const hasWorkspace = (diagnostics?.workspaceCount || 0) > 0;
  const hasSemanticModel = (diagnostics?.tableCount || 0) > 0 && (diagnostics?.columnCount || 0) > 0;
  const hasReport = (diagnostics?.reportCount || 0) > 0 && (diagnostics?.pageCount || 0) > 0 && (diagnostics?.visualCount || 0) > 0;
  const unsupported = diagnostics?.unsupportedArtifactCount || 0;
  const hasDirectPbix = binaryArtifacts.length > 0;
  const directPbixReady = hasDirectPbix && engineStatus === 'ready' && Boolean(engineResult);
  const projectReady = status === 'ready' && hasSemanticModel && hasReport && (unsupported === 0 || exceptionsAcknowledged);
  const ready = directPbixReady || projectReady;
  const files = useMemo(() => artifacts.map((artifact) => ({ ...artifact, mappingCount: result?.mappings.filter((mapping) => mapping.sourceArtifact === artifact.name).length || 0 })), [artifacts, result]);
  const evidenceDisclosure = useMemo(() => result ? semanticMigrationAiEvidenceSummary(result.inventory, rawSourceEnabled) : null, [rawSourceEnabled, result]);

  useEffect(() => { onReadyChange(step === 'ready' && ready); }, [onReadyChange, ready, step]);
  useEffect(() => { setExceptionsAcknowledged(false); if (artifacts.length === 0 && binaryArtifacts.length === 0) setStep('add'); }, [artifacts, binaryArtifacts.length]);
  useEffect(() => {
    folderInputRef.current?.setAttribute('webkitdirectory', '');
    folderInputRef.current?.setAttribute('directory', '');
  }, []);

  return <div className="space-y-4">
    <div className="flex"><StepPill label="1. Add project exports" active={step === 'add'} complete={step !== 'add'} /><StepPill label="2. Review evidence" active={step === 'review'} complete={step === 'ready'} /><StepPill label="3. Ready" active={step === 'ready'} complete={step === 'ready' && ready} /></div>
    <div className="rounded-button border border-blue-200 bg-blue-50 p-3 text-xs text-blue-900">
      Add a PBIX file directly, or provide a semantic model definition (`model.bim` or TMDL) with PBIR/report JSON. Direct PBIX analysis runs in OmniKit's local read-only migration engine; uploaded bytes remain transient. Workspace scanner metadata is helpful for ownership and governance, but it is optional.
      <a className="ml-2 inline-flex items-center gap-1 font-semibold underline" href="https://learn.microsoft.com/en-us/power-bi/developer/projects/projects-dataset" target="_blank" rel="noreferrer">Semantic model files <ExternalLink size={11} /></a>
      <a className="ml-2 inline-flex items-center gap-1 font-semibold underline" href="https://learn.microsoft.com/en-us/power-bi/developer/projects/projects-report" target="_blank" rel="noreferrer">PBIR report files <ExternalLink size={11} /></a>
    </div>

    {step === 'add' && <div className="space-y-3">
      <input ref={inputRef} type="file" multiple accept=".pbix,.zip,.json,.bim,.tmdl,.pbir,.pbip,.pbism,.m,.txt,.yaml,.yml" className="hidden" onChange={(event) => onFiles(event.target.files)} />
      <input ref={folderInputRef} type="file" multiple className="hidden" onChange={(event) => onFiles(event.target.files)} />
      <div className="grid gap-2 sm:grid-cols-2">
        <button type="button" onClick={() => inputRef.current?.click()} className="btn-primary justify-center text-sm"><Upload size={14} />Upload files or ZIP</button>
        <button type="button" onClick={() => folderInputRef.current?.click()} className="btn-secondary justify-center text-sm"><Upload size={14} />Choose project folder</button>
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        {[['Workspace context', hasWorkspace, 'Optional scanner metadata'], ['Semantic model', hasSemanticModel, 'Tables and columns; measures are optional'], ['Report', hasReport, 'Pages, visuals, filters, field references']].map(([label, found, detail]) => <div key={String(label)} className={`rounded-button border p-3 ${found ? 'border-green-200 bg-green-50' : 'border-border bg-surface-secondary'}`}><div className="text-xs font-semibold">{String(label)} {found ? 'found' : label === 'Workspace context' ? 'optional' : 'needed'}</div><div className="mt-1 text-[11px] text-content-secondary">{String(detail)}</div></div>)}
      </div>
      {(artifacts.length > 0 || binaryArtifacts.length > 0) && <button type="button" onClick={() => setStep('review')} className="btn-primary w-full justify-center text-sm" disabled={status === 'parsing' || engineStatus === 'analyzing'}>{status === 'parsing' || engineStatus === 'analyzing' ? <Loader2 size={14} className="animate-spin" /> : <ArrowRight size={14} />}Review parsed evidence</button>}
    </div>}

    {step === 'review' && <div className="space-y-3">
      {status === 'failed' && <div className="rounded-button border border-red-200 bg-red-50 p-3 text-xs text-red-700"><div>{error}</div>{/vault locked/i.test(error) && <a href="/" target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 font-semibold underline">Unlock vault in a new tab <ExternalLink size={11} /></a>}</div>}
      {hasDirectPbix && engineStatus === 'fallback' && <div className="rounded-button border border-red-200 bg-red-50 p-3 text-xs text-red-700"><div className="font-semibold">Direct PBIX analysis could not complete.</div><div className="mt-1">{engineError || 'The local migration engine is unavailable.'}</div><div className="mt-1">Install or repair the managed engine, or export this project as PBIP/PBIR and upload those files instead.</div></div>}
      {binaryArtifacts.map((artifact) => <div key={artifact.name} className="flex items-center justify-between gap-3 rounded-button border border-border p-3"><div className="min-w-0"><div className="truncate text-xs font-semibold"><FileJson2 size={13} className="mr-1 inline" />{artifact.name}</div><div className="mt-1 text-[11px] text-content-secondary">Direct PBIX · {(artifact.sizeBytes / 1024 / 1024).toFixed(1)} MB · {engineStatus === 'ready' ? 'normalized locally' : engineStatus === 'analyzing' ? 'analyzing locally' : 'waiting for local analysis'}</div></div><button type="button" aria-label={`Remove ${artifact.name}`} onClick={() => onBinaryRemove(artifact.name)} className="icon-btn"><Trash2 size={14} /></button></div>)}
      {files.map((artifact) => <div key={artifact.id} className="flex items-center justify-between gap-3 rounded-button border border-border p-3"><div className="min-w-0"><div className="truncate text-xs font-semibold"><FileJson2 size={13} className="mr-1 inline" />{artifact.name}</div><div className="mt-1 text-[11px] text-content-secondary">{artifact.mappingCount ? `${artifact.mappingCount} normalized mapping${artifact.mappingCount === 1 ? '' : 's'}` : 'No supported Power BI evidence found'}</div></div><button type="button" aria-label={`Remove ${artifact.name}`} onClick={() => onRemove(artifact.id)} className="icon-btn"><Trash2 size={14} /></button></div>)}
      {engineResult && <div className="rounded-button border border-blue-200 bg-blue-50 p-3 text-xs text-blue-900"><div className="font-semibold">Deterministic PBIX inventory ready</div><div className="mt-1">{engineResult.engine.name} {engineResult.engine.version}{engineResult.engine.revision ? ` @ ${engineResult.engine.revision.slice(0, 12)}` : ''} · rulebook {engineResult.diagnostics.rulebook_version}</div><div className="mt-1">{engineResult.diagnostics.view_count} views · {engineResult.diagnostics.topic_count} topics · {engineResult.diagnostics.dashboard_count} dashboards · {engineResult.diagnostics.field_count} fields · {engineResult.diagnostics.untranslatable_count} items requiring review</div></div>}
      {diagnostics && <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">{[['Workspaces', diagnostics.workspaceCount], ['Models', diagnostics.semanticModelCount], ['Tables', diagnostics.tableCount], ['Columns', diagnostics.columnCount], ['Measures', diagnostics.measureCount], ['Relationships', diagnostics.relationshipCount], ['RLS roles', diagnostics.roleCount], ['Reports', diagnostics.reportCount], ['Pages', diagnostics.pageCount], ['Visuals', diagnostics.visualCount], ['Warnings', diagnostics.warnings.length]].map(([label, count]) => <div key={String(label)} className="rounded-button border border-border p-2"><div className="text-lg font-semibold">{count}</div><div className="text-[10px] text-content-secondary">{label}</div></div>)}</div>}
      {diagnostics?.warnings.map((warning) => <div key={warning} className="flex gap-2 rounded-button border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-900"><AlertTriangle size={13} className="mt-0.5 shrink-0" />{warning}</div>)}
      {unsupported > 0 && <label className="flex gap-2 text-xs text-content-secondary"><input type="checkbox" checked={exceptionsAcknowledged} onChange={(event) => setExceptionsAcknowledged(event.target.checked)} />Continue without evidence from {unsupported} unsupported file{unsupported === 1 ? '' : 's'}.</label>}
      <div className="rounded-button border border-border bg-surface-secondary p-3">
        <div className="flex items-start gap-2"><ShieldCheck size={15} className="mt-0.5 shrink-0 text-omni-600" /><div><div className="text-xs font-semibold text-content-primary">AI evidence disclosure</div><div className="mt-1 text-[11px] leading-relaxed text-content-secondary">Provider: {providerLabel}. Mode: {evidenceDisclosure?.mode === 'normalized_and_raw' ? 'normalized evidence plus approved raw snippets' : 'normalized evidence only'}. Approximate prompt evidence: {(evidenceDisclosure?.approximatePayloadCharacters || 0).toLocaleString()} characters.</div><div className="mt-1 text-[11px] leading-relaxed text-content-secondary">Normalized content: {evidenceDisclosure?.providerCategories.join(', ') || 'none detected'}. Uploaded artifact types: {evidenceDisclosure?.artifactCategories.join(', ') || 'none'}.</div><div className="mt-1 text-[11px] leading-relaxed text-content-secondary">{evidenceDisclosure?.redaction || 'Principal identities, emails, user IDs, credentials, and bearer tokens are removed before prompt construction.'}</div></div></div>
        <label className="mt-3 flex items-start gap-2 text-xs text-content-secondary"><input type="checkbox" checked={rawSourceEnabled} onChange={(event) => onRawSourceEnabledChange(event.target.checked)} /><span><span className="font-semibold text-content-primary">Also include bounded raw source snippets</span><br />Explicitly opt in to send up to 8 uploaded files, 12,000 characters each and 36,000 characters total, to {providerLabel}. Full files remain transient in page memory.</span></label>
      </div>
      <div className="flex gap-2"><button type="button" onClick={() => setStep('add')} className="btn-secondary text-sm"><ArrowLeft size={14} />Back</button><button type="button" onClick={() => setStep('ready')} disabled={!ready} className="btn-primary flex-1 justify-center text-sm disabled:opacity-50"><CheckCircle2 size={14} />Confirm Power BI inventory</button></div>
    </div>}

    {step === 'ready' && <div className="space-y-3">
      <div className="rounded-button border border-green-200 bg-green-50 p-4 text-sm text-green-800"><div className="font-semibold">Power BI evidence ready for migration planning</div><div className="mt-1 text-xs">OmniKit will send {hasDirectPbix ? 'only the locally normalized PBIX evidence' : rawSourceEnabled ? 'normalized evidence plus the bounded raw snippets you approved' : 'normalized evidence only'} to {providerLabel}. Raw exports remain transient, and no Omni changes occur until reviewed deliverables are saved to a branch.</div></div>
      <div className="flex gap-2"><button type="button" onClick={() => setStep('review')} className="btn-secondary text-sm"><ArrowLeft size={14} />Review again</button><button type="button" onClick={onClear} className="btn-secondary text-sm"><Trash2 size={14} />Start over</button></div>
    </div>}
  </div>;
}
