import { useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileText,
  Loader2,
  Play,
  RefreshCw,
  ShieldCheck,
  Upload,
  XCircle,
} from 'lucide-react';
import { useConnection } from '@/hooks/useConnection';
import { WorkflowStatusScene } from '@/components/ui/WorkflowStatusScene';
import { friendlyApiError } from '@/utils/apiErrors';
import { csvRowsToText } from '@/utils/csvExport';
import {
  executeIdentityImport,
  IDENTITY_IMPORT_TEMPLATE,
  parseIdentityImportCsv,
  preflightIdentityImport,
  type IdentityImportPlan,
  type IdentityImportPreflight,
  type IdentityImportProgress,
  type IdentityImportResult,
} from '@/services/userManagement/bulkIdentityImport';

const MAX_CSV_BYTES = 5 * 1024 * 1024;

function downloadCsv(fileName: string, rows: Array<Array<string | number>>) {
  const csv = csvRowsToText(rows);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function BulkIdentityImportPage() {
  const { connection } = useConnection();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [csvText, setCsvText] = useState('');
  const [fileName, setFileName] = useState('');
  const [plan, setPlan] = useState<IdentityImportPlan | null>(null);
  const [preflight, setPreflight] = useState<IdentityImportPreflight | null>(null);
  const [validating, setValidating] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<IdentityImportProgress | null>(null);
  const [results, setResults] = useState<IdentityImportResult[]>([]);
  const [error, setError] = useState('');
  const [confirmDeletes, setConfirmDeletes] = useState(false);

  function clearAnalysis(nextText = csvText) {
    setCsvText(nextText);
    setPlan(null);
    setPreflight(null);
    setResults([]);
    setProgress(null);
    setError('');
    setConfirmDeletes(false);
  }

  async function handleFile(file: File) {
    if (file.size > MAX_CSV_BYTES) {
      setError('CSV files are limited to 5 MB for local preflight safety.');
      return;
    }
    if (!file.name.toLowerCase().endsWith('.csv')) {
      setError('Choose a .csv file.');
      return;
    }
    try {
      const text = await file.text();
      setFileName(file.name);
      clearAnalysis(text);
    } catch (fileError) {
      setError(friendlyApiError(fileError, 'Could not read the CSV file'));
    }
  }

  async function analyzeCsv() {
    setError('');
    setResults([]);
    setProgress(null);
    setPreflight(null);
    let parsed: IdentityImportPlan;
    try {
      parsed = parseIdentityImportCsv(csvText);
      setPlan(parsed);
    } catch (parseError) {
      setPlan(null);
      setError(friendlyApiError(parseError, 'Could not parse the CSV'));
      return;
    }

    if (parsed.issues.some((issue) => issue.severity === 'error')) return;
    setValidating(true);
    try {
      const checked = await preflightIdentityImport(connection.baseUrl, connection.apiKey, parsed);
      setPreflight(checked);
    } catch (preflightError) {
      setError(friendlyApiError(
        preflightError,
        'Preflight failed. User and group APIs require an Omni Organization API key',
      ));
    } finally {
      setValidating(false);
    }
  }

  async function runImport() {
    if (!preflight) return;
    setRunning(true);
    setError('');
    setResults([]);
    setProgress({ completed: 0, total: 1, stage: 'Starting', message: 'Preparing identity changes' });
    try {
      const nextResults = await executeIdentityImport(
        connection.baseUrl,
        connection.apiKey,
        preflight,
        setProgress,
      );
      setResults(nextResults);
    } catch (runError) {
      setError(friendlyApiError(runError, 'Identity import failed'));
    } finally {
      setRunning(false);
    }
  }

  function exportResults() {
    downloadCsv('omnikit-identity-import-results.csv', [
      ['status', 'stage', 'rows', 'message'],
      ...results.map((result) => [result.status, result.stage, result.rowNumbers.join('|'), result.message]),
    ]);
  }

  const issues = preflight?.issues || plan?.issues || [];
  const errorCount = issues.filter((issue) => issue.severity === 'error').length;
  const hasDeletes = Boolean(preflight?.changes.usersToDelete);
  const canRun = Boolean(preflight && errorCount === 0 && (!hasDeletes || confirmDeletes) && !running);
  const completed = results.length > 0 && !running;
  const successfulResults = results.filter((result) => result.status === 'succeeded').length;
  const failedResults = results.filter((result) => result.status === 'failed').length;

  return (
    <div className="space-y-5">
      <section className="card p-0 overflow-hidden">
        <div className="px-5 py-4 border-b border-border flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold text-content-primary">
              <Upload size={16} className="text-omni-600" />
              Bulk identity import
            </div>
            <p className="mt-1 text-xs text-content-secondary leading-5 max-w-3xl">
              Use one CSV to create or update users, ensure groups exist, and apply memberships. OmniKit validates the complete plan before making changes.
            </p>
          </div>
          <button
            type="button"
            onClick={() => downloadCsv('omnikit-identity-import-template.csv', IDENTITY_IMPORT_TEMPLATE)}
            className="btn-secondary text-sm"
          >
            <Download size={14} />
            Download template
          </button>
        </div>

        <div className="grid border-b border-border md:grid-cols-3">
          <div className="px-5 py-4 border-b border-border md:border-b-0 md:border-r">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-content-secondary">1. Prepare</div>
            <div className="mt-1 text-sm font-medium text-content-primary">One operation per row</div>
            <p className="mt-1 text-xs text-content-secondary">Use user, group, or membership with an explicit action.</p>
          </div>
          <div className="px-5 py-4 border-b border-border md:border-b-0 md:border-r">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-content-secondary">2. Validate</div>
            <div className="mt-1 text-sm font-medium text-content-primary">No writes during preflight</div>
            <p className="mt-1 text-xs text-content-secondary">OmniKit checks identities, groups, and attribute references first.</p>
          </div>
          <div className="px-5 py-4">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-content-secondary">3. Apply</div>
            <div className="mt-1 text-sm font-medium text-content-primary">Dependency-safe order</div>
            <p className="mt-1 text-xs text-content-secondary">Users, groups, memberships, then confirmed deletions.</p>
          </div>
        </div>

        <div className="px-5 py-5 space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void handleFile(file);
                event.target.value = '';
              }}
            />
            <button type="button" onClick={() => fileInputRef.current?.click()} className="btn-secondary text-sm">
              <FileText size={14} />
              Choose CSV
            </button>
            <div className="text-xs text-content-secondary">
              {fileName || 'No file selected. You can also paste CSV below.'}
            </div>
          </div>

          <textarea
            value={csvText}
            onChange={(event) => {
              setFileName('');
              clearAnalysis(event.target.value);
            }}
            className="input-field min-h-48 resize-y font-mono text-xs leading-5"
            spellCheck={false}
            placeholder="record_type,action,email,display_name,group_name&#10;user,upsert,analyst@example.com,Example Analyst,&#10;group,ensure,,,Analytics Users&#10;membership,add,analyst@example.com,,Analytics Users"
          />

          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-start gap-2 text-xs text-content-secondary max-w-3xl">
              <ShieldCheck size={15} className="mt-0.5 shrink-0 text-green-700" />
              <span>
                Requires an Organization API key. Columns prefixed with attribute_ must use an existing Omni user-attribute reference. CSV content stays in this browser session; OmniKit sends only validated SCIM operations.
              </span>
            </div>
            <button
              type="button"
              onClick={analyzeCsv}
              disabled={!csvText.trim() || validating || running}
              className="btn-primary text-sm disabled:opacity-40"
            >
              {validating ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
              {validating ? 'Checking Omni...' : 'Validate import'}
            </button>
          </div>
        </div>
      </section>

      {error && (
        <div className="rounded-card border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {plan && (
        <section className="card p-0 overflow-hidden">
          <div className="px-5 py-4 border-b border-border flex items-center justify-between gap-4">
            <div>
              <div className="text-sm font-semibold text-content-primary">Import preflight</div>
              <p className="mt-0.5 text-xs text-content-secondary">
                {preflight ? 'Checked against the active Omni instance.' : 'Local CSV checks complete.'}
              </p>
            </div>
            <div className={`rounded-chip px-3 py-1 text-xs font-semibold ${errorCount > 0 ? 'bg-red-100 text-red-800' : preflight ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-700'}`}>
              {errorCount > 0 ? `${errorCount} blocking` : preflight ? 'Ready' : 'Needs Omni check'}
            </div>
          </div>

          <div className="grid border-b border-border sm:grid-cols-2 lg:grid-cols-5">
            {[
              ['User upserts', plan.summary.userUpserts],
              ['User deletes', plan.summary.userDeletes],
              ['Groups', plan.summary.groupsEnsured],
              ['Membership adds', plan.summary.membershipsAdded],
              ['Membership removals', plan.summary.membershipsRemoved],
            ].map(([label, value]) => (
              <div key={label} className="px-4 py-3 border-b border-border last:border-b-0 sm:border-r lg:border-b-0">
                <div className="text-[11px] uppercase tracking-wider text-content-secondary">{label}</div>
                <div className="mt-1 text-lg font-semibold text-content-primary">{value}</div>
              </div>
            ))}
          </div>

          {preflight && (
            <div className="grid border-b border-border bg-surface-secondary sm:grid-cols-2 lg:grid-cols-6">
              {[
                ['Create users', preflight.changes.usersToCreate],
                ['Update users', preflight.changes.usersToUpdate],
                ['Delete users', preflight.changes.usersToDelete],
                ['Create groups', preflight.changes.groupsToCreate],
                ['Add members', preflight.changes.membershipAdds],
                ['Remove members', preflight.changes.membershipRemoves],
              ].map(([label, value]) => (
                <div key={label} className="px-4 py-3 border-b border-border last:border-b-0 sm:border-r lg:border-b-0">
                  <div className="text-[10px] uppercase tracking-wider text-content-secondary">{label}</div>
                  <div className="mt-1 text-sm font-semibold text-content-primary">{value}</div>
                </div>
              ))}
            </div>
          )}

          {issues.length > 0 && (
            <div className="divide-y divide-border">
              {issues.map((issue, index) => (
                <div key={`${issue.message}-${index}`} className="px-5 py-3 flex items-start gap-2 text-xs">
                  {issue.severity === 'error'
                    ? <XCircle size={15} className="mt-0.5 shrink-0 text-red-600" />
                    : <AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber-600" />}
                  <span className={issue.severity === 'error' ? 'text-red-700' : 'text-amber-800'}>
                    {issue.rowNumber ? `Row ${issue.rowNumber}: ` : ''}{issue.message}
                  </span>
                </div>
              ))}
            </div>
          )}

          {preflight && hasDeletes && (
            <label className="px-5 py-4 border-t border-border flex items-start gap-3 cursor-pointer bg-red-50/60">
              <input
                type="checkbox"
                checked={confirmDeletes}
                onChange={(event) => setConfirmDeletes(event.target.checked)}
                className="mt-0.5 accent-red-600"
              />
              <span>
                <span className="block text-sm font-semibold text-red-800">Confirm {preflight.changes.usersToDelete} permanent user deletion{preflight.changes.usersToDelete === 1 ? '' : 's'}</span>
                <span className="block mt-0.5 text-xs text-red-700">Deletions run last and cannot be undone. Transfer schedules and ownership before continuing.</span>
              </span>
            </label>
          )}

          {preflight && (
            <div className="px-5 py-4 border-t border-border flex justify-end">
              <button type="button" onClick={runImport} disabled={!canRun} className="btn-primary text-sm disabled:opacity-40">
                {running ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                {running ? 'Applying changes...' : 'Run identity import'}
              </button>
            </div>
          )}
        </section>
      )}

      {(running || progress) && (
        <section className="card bg-surface-secondary space-y-3">
          <WorkflowStatusScene
            variant="bulk-upload"
            title={running ? 'Applying identity changes' : failedResults > 0 ? 'Import completed with failures' : 'Identity import complete'}
            detail={progress ? `${progress.stage}: ${progress.message}` : 'Preparing the import.'}
            statusLabel={running ? 'Running' : failedResults > 0 ? 'Needs review' : 'Complete'}
            progressLabel={progress ? `${progress.completed}/${progress.total} API batches complete` : undefined}
            compact
          />
          {progress && (
            <div className="h-2 overflow-hidden rounded-full bg-gray-200">
              <div
                className="h-full rounded-full bg-omni-700 transition-all duration-300"
                style={{ width: `${Math.min(100, (progress.completed / Math.max(1, progress.total)) * 100)}%` }}
              />
            </div>
          )}
        </section>
      )}

      {completed && (
        <section className="card p-0 overflow-hidden">
          <div className="px-5 py-4 border-b border-border flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              {failedResults > 0
                ? <AlertTriangle size={20} className="text-amber-600" />
                : <CheckCircle2 size={20} className="text-green-700" />}
              <div>
                <div className="text-sm font-semibold text-content-primary">Import results</div>
                <p className="mt-0.5 text-xs text-content-secondary">{successfulResults} succeeded · {failedResults} failed · {results.length - successfulResults - failedResults} skipped</p>
              </div>
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={exportResults} className="btn-secondary text-sm">
                <Download size={14} />
                Export results
              </button>
              <button
                type="button"
                onClick={() => {
                  setCsvText('');
                  setFileName('');
                  clearAnalysis('');
                }}
                className="btn-secondary text-sm"
              >
                <RefreshCw size={14} />
                New import
              </button>
            </div>
          </div>
          <div className="max-h-80 divide-y divide-border overflow-y-auto">
            {results.map((result, index) => (
              <div key={`${result.stage}-${result.message}-${index}`} className="px-5 py-3 flex items-start gap-3 text-xs">
                {result.status === 'succeeded'
                  ? <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-green-700" />
                  : result.status === 'failed'
                    ? <XCircle size={14} className="mt-0.5 shrink-0 text-red-600" />
                    : <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-600" />}
                <div>
                  <span className="font-semibold uppercase tracking-wider text-content-secondary">{result.stage}</span>
                  <span className="ml-2 text-content-primary">{result.message}</span>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
