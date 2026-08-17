import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle, Image, Loader2, ShieldCheck, Trash2, XCircle } from 'lucide-react';
import {
  trashAiContentDocument,
  verifyAiContentDocument,
  type AiContentDocumentVerification,
} from '@/services/omniApi';
import { exportFullDashboardAsPng } from '@/services/deckBuilder/omniDeckApi';
import type { AIContentDocumentReference, AIContentMode } from '@/services/aiContentStudio/types';

const MAX_PREVIEW_BYTES = 12 * 1024 * 1024;

const APP_MANUAL_CHECKS = [
  ['workbook-query-contract', 'The exact App is paired with the intended workbook, uses no more than 100 wired queries, and every required query returns rows with the expected aliases, types, grain, and schema.'],
  ['populated-selectors', 'Every required selector and input control is populated from governed query results or an explicitly approved bounded value set.'],
  ['filter-propagation', 'Changing each selector or input control updates the intended filtered query and displayed content.'],
  ['finite-values', 'Ranges, counts, and rendered values are finite; the interface shows no unintended undefined, null, or NaN values.'],
  ['primary-actions', 'Every primary action and navigation control requested in the brief changes state correctly and stops at valid boundaries.'],
  ['ui-states', 'Default, loading, empty, error, and reload states are usable and preserve intended filters.'],
  ['governance', 'Ownership, permissions, sharing, and sandbox settings match the intended audience and governance boundary.'],
  ['disposition', 'The exact App was retained after functional verification or moved to recoverable Trash.'],
] as const;

interface VerificationView {
  identifier: string;
  state: 'checking' | 'verified' | 'blocked';
  evidence?: AiContentDocumentVerification;
  issues: string[];
}

function exactIdentifier(value: string): string {
  const trimmed = value.trim();
  return trimmed && trimmed.length <= 200 && !/[/?#]/.test(trimmed) ? trimmed : '';
}

function reconcileVerification(
  evidence: AiContentDocumentVerification,
  expectedName: string,
  expectedModelId: string,
): VerificationView {
  const issues: string[] = [];
  if (evidence.name.trim() !== expectedName.trim()) {
    issues.push(`NAME_MISMATCH: expected "${expectedName.trim()}", reread "${evidence.name.trim()}".`);
  }
  if (evidence.modelId.trim() !== expectedModelId.trim()) {
    issues.push(`MODEL_MISMATCH: expected ${expectedModelId.trim()}, reread ${evidence.modelId.trim() || 'no model identifier'}.`);
  }
  if (evidence.queryCount < 1 || evidence.queries.length < 1) {
    issues.push('NO_GOVERNED_QUERIES: the verified dashboard reread did not contain a query to validate.');
  }
  if (evidence.queryPresentationCount < 1) {
    issues.push('NO_QUERY_PRESENTATIONS: Documents V2 did not return a dashboard tile/query presentation.');
  }
  if (evidence.layoutContainerCount < 1) {
    issues.push('NO_DASHBOARD_LAYOUT: Documents V2 did not return a dashboard layout container.');
  }
  evidence.queries.forEach((query) => {
    if (query.modelIds.length === 0) {
      issues.push(`QUERY_MODEL_UNKNOWN: query ${query.id} did not expose a model association.`);
    } else if (query.modelIds.some((modelId) => modelId !== expectedModelId.trim())) {
      issues.push(`QUERY_MODEL_MISMATCH: query ${query.id} references ${query.modelIds.join(', ')} instead of only ${expectedModelId.trim()}.`);
    }
  });
  if (evidence.contentValidationIssues.length > 0) {
    issues.push(...evidence.contentValidationIssues.map((issue) => `CONTENT_VALIDATION: ${issue}`));
  }
  return {
    identifier: evidence.identifier,
    state: issues.length > 0 ? 'blocked' : 'verified',
    evidence,
    issues,
  };
}

export function ArtifactReconciliationPanel({
  baseUrl,
  apiKey,
  mode,
  expectedName,
  expectedModelId,
  references,
}: {
  baseUrl: string;
  apiKey: string;
  mode: AIContentMode;
  expectedName: string;
  expectedModelId: string;
  references: AIContentDocumentReference[];
}) {
  const candidates = useMemo(
    () => mode === 'dashboard'
      ? Array.from(new Set(references.map((reference) => exactIdentifier(reference.documentId)).filter(Boolean)))
      : [],
    [mode, references],
  );
  const [manualId, setManualId] = useState('');
  const [verificationViews, setVerificationViews] = useState<VerificationView[]>([]);
  const [verifyingManual, setVerifyingManual] = useState(false);
  const [cleanupApproved, setCleanupApproved] = useState(false);
  const [cleanupConfirmation, setCleanupConfirmation] = useState('');
  const [trashing, setTrashing] = useState(false);
  const [trashedIdentifier, setTrashedIdentifier] = useState('');
  const [cleanupError, setCleanupError] = useState('');
  const [previewState, setPreviewState] = useState<'idle' | 'loading' | 'decoded' | 'failed'>('idle');
  const [previewError, setPreviewError] = useState('');
  const [previewUrl, setPreviewUrl] = useState('');
  const [appLocatedAcknowledged, setAppLocatedAcknowledged] = useState(false);
  const [appManualChecks, setAppManualChecks] = useState<Set<string>>(() => new Set());
  const previewUrlRef = useRef('');

  const verified = verificationViews.find((view) => view.state === 'verified');
  const needsManual = mode === 'dashboard'
    && (candidates.length === 0 || (verificationViews.length === candidates.length && verificationViews.every((view) => view.state === 'blocked')));
  const appReferenceFingerprint = useMemo(
    () => references.map((reference) => `${reference.actionType}:${reference.documentId}`).sort().join('|'),
    [references],
  );

  useEffect(() => {
    setAppLocatedAcknowledged(false);
    setAppManualChecks(new Set());
  }, [appReferenceFingerprint, expectedModelId, expectedName, mode]);

  useEffect(() => {
    const controller = new AbortController();
    setVerificationViews(candidates.map((identifier) => ({ identifier, state: 'checking', issues: [] })));
    setManualId('');
    setCleanupApproved(false);
    setCleanupConfirmation('');
    setTrashedIdentifier('');
    setCleanupError('');
    if (candidates.length === 0) return () => controller.abort();

    void Promise.all(candidates.map(async (identifier): Promise<VerificationView> => {
      try {
        const evidence = await verifyAiContentDocument(baseUrl, apiKey, identifier, controller.signal);
        return reconcileVerification(evidence, expectedName, expectedModelId);
      } catch (cause) {
        if (controller.signal.aborted) throw cause;
        return {
          identifier,
          state: 'blocked',
          issues: [cause instanceof Error ? cause.message : 'The authoritative document reread failed.'],
        };
      }
    })).then((views) => {
      if (!controller.signal.aborted) setVerificationViews(views);
    }).catch(() => undefined);
    return () => controller.abort();
  }, [apiKey, baseUrl, candidates, expectedModelId, expectedName]);

  useEffect(() => {
    if (mode !== 'dashboard' || !verified || trashedIdentifier === verified.identifier) return undefined;
    const controller = new AbortController();
    setPreviewState('loading');
    setPreviewError('');
    void exportFullDashboardAsPng(baseUrl, apiKey, verified.identifier, controller.signal)
      .then((blob) => {
        if (controller.signal.aborted) return;
        if (blob.size <= 0 || blob.size > MAX_PREVIEW_BYTES) {
          throw new Error(`The PNG preview was outside the bounded 12 MiB preview budget (${blob.size.toLocaleString()} bytes).`);
        }
        if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
        const nextUrl = URL.createObjectURL(blob);
        previewUrlRef.current = nextUrl;
        setPreviewUrl(nextUrl);
      })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        setPreviewState('failed');
        setPreviewError(cause instanceof Error ? cause.message : 'The PNG preview could not be retrieved.');
      });
    return () => controller.abort();
  }, [apiKey, baseUrl, mode, trashedIdentifier, verified]);

  useEffect(() => () => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
  }, []);

  async function verifyManualIdentifier() {
    const identifier = exactIdentifier(manualId);
    if (!identifier || verifyingManual) return;
    setVerifyingManual(true);
    setCleanupError('');
    setVerificationViews((current) => [
      ...current.filter((view) => view.identifier !== identifier),
      { identifier, state: 'checking', issues: [] },
    ]);
    try {
      const evidence = await verifyAiContentDocument(baseUrl, apiKey, identifier);
      const next = reconcileVerification(evidence, expectedName, expectedModelId);
      setVerificationViews((current) => [...current.filter((view) => view.identifier !== identifier), next]);
    } catch (cause) {
      setVerificationViews((current) => [
        ...current.filter((view) => view.identifier !== identifier),
        {
          identifier,
          state: 'blocked',
          issues: [cause instanceof Error ? cause.message : 'The authoritative document reread failed.'],
        },
      ]);
    } finally {
      setVerifyingManual(false);
    }
  }

  async function moveVerifiedArtifactToTrash() {
    if (
      !verified
      || cleanupConfirmation.trim() !== verified.identifier
      || !cleanupApproved
      || trashing
    ) return;
    setTrashing(true);
    setCleanupError('');
    try {
      const result = await trashAiContentDocument(baseUrl, apiKey, verified.identifier);
      if (result.identifier !== verified.identifier || result.trashed !== true) {
        throw new Error('Omni did not confirm that the exact verified identifier moved to Trash.');
      }
      setTrashedIdentifier(result.identifier);
      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current);
        previewUrlRef.current = '';
        setPreviewUrl('');
      }
    } catch (cause) {
      setCleanupError(cause instanceof Error ? cause.message : 'The verified artifact could not be moved to Trash.');
    } finally {
      setTrashing(false);
    }
  }

  return (
    <section aria-labelledby="artifact-reconciliation-heading" className="space-y-3 rounded-card border border-border bg-surface-secondary p-4">
      <div>
        <h3 id="artifact-reconciliation-heading" className="text-sm font-semibold text-content-primary">
          {mode === 'app' ? 'App verification handoff' : 'Authoritative artifact reconciliation'}
        </h3>
        <p className="mt-1 text-xs leading-5 text-content-secondary">
          {mode === 'app'
            ? 'Returned App references remain unverified because this studio has no equivalent documented App retrieval contract. Verify the exact App and its paired workbook manually in Omni.'
            : 'Returned identifiers are reread through documented dashboard metadata, query, filter/control, and model content-validation APIs. AI prose never establishes verification.'}
        </p>
      </div>

      {mode === 'app' && (
        <div className="rounded-card border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900">
          <div className="font-semibold">Manual App functional verification — not API verification</div>
          <p className="mt-1">
            Omni does not expose an equivalent documented App-type retrieval contract here, so this studio cannot label or clean up the returned identifier automatically. Locate the exact App in Omni before using the checklist. Marks stay only in this browser view and are not persisted as audit evidence or OmniKit API verification.
          </p>
          <label className="mt-3 flex items-start gap-2 rounded-card border border-amber-300 bg-white px-3 py-2 font-medium">
            <input
              type="checkbox"
              className="mt-1"
              checked={appLocatedAcknowledged}
              onChange={(event) => {
                setAppLocatedAcknowledged(event.target.checked);
                if (!event.target.checked) setAppManualChecks(new Set());
              }}
            />
            <span>I located the exact App <strong>{expectedName.trim() || 'requested by this job'}</strong> in Omni and opened its paired workbook.</span>
          </label>
          <fieldset
            aria-label="Manual App functional verification checklist"
            className={`mt-3 space-y-2 ${appLocatedAcknowledged ? '' : 'opacity-60'}`}
            disabled={!appLocatedAcknowledged}
          >
            <legend className="sr-only">Manual App functional verification checklist</legend>
            {APP_MANUAL_CHECKS.map(([key, label]) => (
              <label key={key} className="flex items-start gap-2 rounded-card border border-amber-200 bg-white/70 px-3 py-2">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={appManualChecks.has(key)}
                  onChange={(event) => {
                    setAppManualChecks((current) => {
                      const next = new Set(current);
                      if (event.target.checked) next.add(key);
                      else next.delete(key);
                      return next;
                    });
                  }}
                />
                <span>{label}</span>
              </label>
            ))}
          </fieldset>
          <p className="mt-3 font-medium">
            {appManualChecks.size} of {APP_MANUAL_CHECKS.length} checks marked in this browser session.
          </p>
        </div>
      )}

      {verificationViews.map((view) => (
        <div key={view.identifier} className={`rounded-card border p-3 text-xs ${view.state === 'verified' ? 'border-emerald-200 bg-emerald-50' : view.state === 'blocked' ? 'border-red-200 bg-red-50' : 'border-border bg-white'}`}>
          <div className="flex items-center gap-2 font-semibold text-content-primary">
            {view.state === 'checking' ? <Loader2 size={14} className="animate-spin" /> : view.state === 'verified' ? <CheckCircle size={14} className="text-emerald-700" /> : <XCircle size={14} className="text-red-700" />}
            <span className="font-mono break-all">{view.identifier}</span>
            <span className="ml-auto">{view.state === 'checking' ? 'Verifying…' : view.state === 'verified' ? 'Dashboard verified' : 'Not verified'}</span>
          </div>
          {view.evidence && (
            <div className="mt-2 leading-5 text-content-secondary">
              Reread <strong>{view.evidence.name}</strong> on model <span className="font-mono">{view.evidence.modelId}</span> with {view.evidence.queryCount} governed queries, {view.evidence.queryPresentationCount} query presentations across {view.evidence.layoutContainerCount} layout containers, {view.evidence.filterCount} filters, {view.evidence.controlCount} controls, and a complete {view.evidence.accessGrantCount}-grant access list ({view.evidence.directAccessGrantCount} direct, {view.evidence.inheritedAccessGrantCount} inherited, {view.evidence.ownerGrantCount} owner).
              {view.evidence.queryPresentationTypes.length > 0 && (
                <span> Presentation types: {view.evidence.queryPresentationTypes.map(({ type, count }) => `${type} (${count})`).join(', ')}.</span>
              )}
            </div>
          )}
          {view.issues.length > 0 && <ul className="mt-2 list-disc space-y-1 pl-5 text-red-800">{view.issues.map((issue) => <li key={issue}>{issue}</li>)}</ul>}
        </div>
      ))}

      {needsManual && (
        <div className="rounded-card border border-amber-200 bg-amber-50 p-3 text-xs">
          <label className="block font-semibold text-amber-950" htmlFor="ai-content-manual-document-id">Exact document identifier</label>
          <p className="mt-1 leading-5 text-amber-900">No returned candidate passed authoritative reconciliation. Copy the exact identifier from Omni after confirming the requested name and scope.</p>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row">
            <input
              id="ai-content-manual-document-id"
              value={manualId}
              onChange={(event) => setManualId(event.target.value)}
              className="input-field font-mono"
              maxLength={200}
              placeholder="Exact Omni document ID or slug"
            />
            <button type="button" className="btn-secondary shrink-0" disabled={!exactIdentifier(manualId) || verifyingManual} onClick={() => void verifyManualIdentifier()}>
              {verifyingManual ? <Loader2 size={13} className="animate-spin" /> : <ShieldCheck size={13} />} Verify exact identifier
            </button>
          </div>
        </div>
      )}

      {verified && mode === 'dashboard' && !trashedIdentifier && (
        <div className="rounded-card border border-border bg-white p-3 text-xs">
          <div className="flex items-center gap-2 font-semibold text-content-primary">
            {previewState === 'loading' ? <Loader2 size={14} className="animate-spin" /> : <Image size={14} />}
            Bounded dashboard PNG preview
          </div>
          {previewUrl && (
            <img
              src={previewUrl}
              alt={`Verified render preview for ${verified.evidence?.name || verified.identifier}`}
              className="mt-3 max-h-[520px] w-full rounded-card border border-border object-contain"
              onLoad={() => setPreviewState('decoded')}
              onError={() => { setPreviewState('failed'); setPreviewError('The returned PNG could not be decoded by the browser.'); }}
            />
          )}
          {previewState === 'decoded' && <p className="mt-2 text-emerald-800"><strong>Render transport verified:</strong> the bounded PNG was retrieved and decoded. Visual correctness still requires human inspection.</p>}
          {previewState === 'failed' && <p className="mt-2 text-red-800"><strong>Render not verified:</strong> {previewError}</p>}
        </div>
      )}

      {verified && !trashedIdentifier && (
        <div className="rounded-card border border-red-200 bg-red-50 p-3 text-xs leading-5 text-red-900">
          <div className="flex items-center gap-2 font-semibold"><Trash2 size={14} /> Recoverable cleanup</div>
          <p className="mt-1">Cleanup moves only the authoritatively verified identifier to Omni Trash. It does not permanently delete the document.</p>
          <label className="mt-3 flex items-start gap-2">
            <input type="checkbox" className="mt-1" checked={cleanupApproved} onChange={(event) => setCleanupApproved(event.target.checked)} />
            <span>I confirm that <span className="font-mono">{verified.identifier}</span> is the exact verified test artifact I intend to move to Trash.</span>
          </label>
          <label className="mt-3 block" htmlFor="ai-content-cleanup-confirmation">Type the exact identifier to confirm</label>
          <input
            id="ai-content-cleanup-confirmation"
            value={cleanupConfirmation}
            onChange={(event) => setCleanupConfirmation(event.target.value)}
            className="input-field mt-1 font-mono"
            autoComplete="off"
          />
          <button
            type="button"
            className="btn-secondary mt-3 text-red-700"
            disabled={!cleanupApproved || cleanupConfirmation.trim() !== verified.identifier || trashing}
            onClick={() => void moveVerifiedArtifactToTrash()}
          >
            {trashing ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
            {trashing ? 'Moving to Trash…' : `Move ${verified.identifier} to Trash`}
          </button>
          {cleanupError && <div role="alert" className="mt-2 text-red-800">{cleanupError}</div>}
        </div>
      )}

      {trashedIdentifier && (
        <div className="flex items-start gap-2 rounded-card border border-emerald-200 bg-emerald-50 p-3 text-xs leading-5 text-emerald-900">
          <CheckCircle size={14} className="mt-0.5 shrink-0" />
          <span>Omni confirmed that <span className="font-mono">{trashedIdentifier}</span> moved to recoverable Trash.</span>
        </div>
      )}
    </section>
  );
}
