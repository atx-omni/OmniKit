import type { ReactNode } from 'react';
import { AlertTriangle, CircleCheck, ExternalLink, ShieldCheck } from 'lucide-react';
import { ArtifactReconciliationPanel } from './ArtifactReconciliationPanel';
import type { AIContentModelMutationCheck } from '@/services/aiContentStudio/modelSnapshot';
import { parseAIContentNarrative } from '@/services/aiContentStudio/narrative';
import type { AIContentJobOutcome, AIContentMode } from '@/services/aiContentStudio/types';

function resultHeading(
  mode: AIContentMode,
  artifactState: AIContentJobOutcome['artifactState'],
  resultAvailability: AIContentJobOutcome['resultAvailability'],
) {
  if (mode === 'review') return 'Blobby dashboard review';
  if (mode === 'report') return 'Narrative report returned — verify findings';
  if (resultAvailability === 'unavailable') {
    return mode === 'app'
      ? 'App job completed — continue in Omni Chat'
      : 'Dashboard job completed — continue in Omni Chat';
  }
  if (artifactState === 'reported-created-unverified') {
    return mode === 'app'
      ? 'App build completed — functional verification required'
      : 'Dashboard job completed — artifact verification required';
  }
  if (artifactState === 'creation-status-unverified') {
    return mode === 'app'
      ? 'App job completed — creation status unverified'
      : 'Dashboard job completed — creation status unverified';
  }
  if (artifactState === 'not-returned') {
    return mode === 'app'
      ? 'App request completed — no artifact reference returned'
      : 'Dashboard request completed — no artifact reference returned';
  }
  if (mode === 'app') return 'App request completed — functional verification required';
  return 'Dashboard job completed — verify in Omni';
}

const MAX_MARKDOWN_TABLE_COLUMNS = 24;
const MAX_MARKDOWN_TABLE_BODY_ROWS = 100;
const MAX_MARKDOWN_TABLE_CELL_CHARACTERS = 2_000;

function boundedTableCell(value: string): { value: string; truncated: boolean } {
  const normalized = value.trim();
  if (normalized.length <= MAX_MARKDOWN_TABLE_CELL_CHARACTERS) {
    return { value: normalized, truncated: false };
  }
  return {
    value: `${normalized.slice(0, MAX_MARKDOWN_TABLE_CELL_CHARACTERS - 1)}…`,
    truncated: true,
  };
}

function splitMarkdownTableRow(line: string): string[] {
  const trimmed = line.trim();
  const withoutLeadingPipe = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed;
  const withoutBoundaryPipes = withoutLeadingPipe.endsWith('|')
    ? withoutLeadingPipe.slice(0, -1)
    : withoutLeadingPipe;
  const cells: string[] = [];
  let cell = '';
  for (let index = 0; index < withoutBoundaryPipes.length; index += 1) {
    const character = withoutBoundaryPipes[index];
    if (character === '\\' && withoutBoundaryPipes[index + 1] === '|') {
      cell += '|';
      index += 1;
      continue;
    }
    if (character === '|') {
      cells.push(cell.trim());
      cell = '';
      continue;
    }
    cell += character;
  }
  cells.push(cell.trim());
  return cells;
}

function isMarkdownTableSeparator(line: string, expectedColumns: number): boolean {
  const cells = splitMarkdownTableRow(line);
  return expectedColumns >= 2
    && cells.length === expectedColumns
    && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function looksLikeMarkdownTableRow(line: string): boolean {
  return line.includes('|') && splitMarkdownTableRow(line).length >= 2;
}

export function MarkdownLite({ value, headingLevel = 3 }: { value: string; headingLevel?: 3 | 4 }) {
  const Heading = headingLevel === 4 ? 'h4' : 'h3';
  const inline = (text: string): ReactNode[] => text
    .split(/(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*)/g)
    .filter(Boolean)
    .map((part, index) => {
      if (part.startsWith('`') && part.endsWith('`')) {
        return (
          <code key={`${part}-${index}`} className="rounded border border-border bg-surface-secondary px-1 py-0.5 font-mono text-[0.92em]">
            {part.slice(1, -1)}
          </code>
        );
      }
      if (part.startsWith('**') && part.endsWith('**')) {
        return <strong key={`${part}-${index}`} className="font-semibold text-content-primary">{part.slice(2, -2)}</strong>;
      }
      if (part.startsWith('*') && part.endsWith('*')) {
        return <em key={`${part}-${index}`}>{part.slice(1, -1)}</em>;
      }
      return <span key={`${part}-${index}`}>{part}</span>;
    });

  const lines = value.split(/\r?\n/);
  const blocks: ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const trimmed = lines[index].trim();
    if (!trimmed) {
      blocks.push(<div key={`space-${index}`} className="h-1" />);
      index += 1;
      continue;
    }

    const heading = trimmed.match(/^ {0,3}#{1,6}[\t ]+(.+?)(?:[\t ]+#+)?[\t ]*$/);
    if (heading) {
      blocks.push(
        <Heading key={`heading-${index}`} className="pt-2 text-sm font-semibold text-content-primary first:pt-0">
          {inline(heading[1])}
        </Heading>,
      );
      index += 1;
      continue;
    }

    const headerCells = looksLikeMarkdownTableRow(lines[index])
      ? splitMarkdownTableRow(lines[index])
      : [];
    if (
      headerCells.length >= 2
      && index + 1 < lines.length
      && isMarkdownTableSeparator(lines[index + 1], headerCells.length)
    ) {
      const rawRows: string[][] = [];
      let tableIndex = index + 2;
      while (tableIndex < lines.length && looksLikeMarkdownTableRow(lines[tableIndex])) {
        rawRows.push(splitMarkdownTableRow(lines[tableIndex]));
        tableIndex += 1;
      }
      const visibleColumnCount = Math.min(headerCells.length, MAX_MARKDOWN_TABLE_COLUMNS);
      const visibleRows = rawRows.slice(0, MAX_MARKDOWN_TABLE_BODY_ROWS);
      const cellsWereTruncated = [...headerCells, ...rawRows.flat()]
        .some((cell) => cell.trim().length > MAX_MARKDOWN_TABLE_CELL_CHARACTERS);
      const tableWasBounded = headerCells.length > visibleColumnCount
        || rawRows.length > visibleRows.length
        || rawRows.some((row) => row.length > visibleColumnCount)
        || cellsWereTruncated;
      blocks.push(
        <div key={`table-${index}`} className="space-y-2">
          <div className="max-w-full overflow-x-auto rounded-card border border-border" data-testid="ai-content-markdown-table-scroll">
            <table className="min-w-max border-collapse text-left text-xs">
              <thead className="bg-surface-secondary text-content-primary">
                <tr>
                  {headerCells.slice(0, visibleColumnCount).map((cell, cellIndex) => (
                    <th key={`header-${cellIndex}`} scope="col" className="border-b border-border px-3 py-2 align-top font-semibold">
                      {inline(boundedTableCell(cell).value)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="text-content-secondary">
                {visibleRows.map((row, rowIndex) => (
                  <tr key={`row-${rowIndex}`} className="border-t border-border first:border-t-0">
                    {Array.from({ length: visibleColumnCount }, (_, cellIndex) => (
                      <td key={`cell-${cellIndex}`} className="max-w-[28rem] px-3 py-2 align-top">
                        {inline(boundedTableCell(row[cellIndex] || '').value)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {tableWasBounded && (
            <p className="text-xs text-amber-800" role="note">
              Table display bounded to {MAX_MARKDOWN_TABLE_COLUMNS} columns, {MAX_MARKDOWN_TABLE_BODY_ROWS} body rows, and {MAX_MARKDOWN_TABLE_CELL_CHARACTERS.toLocaleString()} characters per cell. Continue in Omni Chat for the complete response.
            </p>
          )}
        </div>,
      );
      index = tableIndex;
      continue;
    }

    const unordered = trimmed.match(/^[-*]\s+(.+)$/);
    if (unordered) {
      const items: string[] = [];
      while (index < lines.length) {
        const item = lines[index].trim().match(/^[-*]\s+(.+)$/);
        if (!item) break;
        items.push(item[1]);
        index += 1;
      }
      blocks.push(
        <ul key={`unordered-${index}`} className="list-disc space-y-1 pl-5 marker:text-omni-500">
          {items.map((item, itemIndex) => <li key={`${itemIndex}-${item}`}>{inline(item)}</li>)}
        </ul>,
      );
      continue;
    }

    const ordered = trimmed.match(/^\d+[.)]\s+(.+)$/);
    if (ordered) {
      const items: string[] = [];
      const startingNumber = Number.parseInt(trimmed, 10);
      while (index < lines.length) {
        const item = lines[index].trim().match(/^\d+[.)]\s+(.+)$/);
        if (!item) break;
        items.push(item[1]);
        index += 1;
      }
      blocks.push(
        <ol key={`ordered-${index}`} className="list-decimal space-y-1 pl-5" start={Number.isFinite(startingNumber) ? startingNumber : 1}>
          {items.map((item, itemIndex) => <li key={`${itemIndex}-${item}`}>{inline(item)}</li>)}
        </ol>,
      );
      continue;
    }

    if (/^-{3,}$/.test(trimmed)) {
      blocks.push(<hr key={`rule-${index}`} className="border-border" />);
      index += 1;
      continue;
    }

    blocks.push(<p key={`paragraph-${index}`}>{inline(trimmed)}</p>);
    index += 1;
  }

  return (
    <div className="space-y-2 text-sm leading-6 text-content-secondary">
      {blocks}
    </div>
  );
}

export function OutcomePanel({
  outcome,
  mode,
  contentName,
  unexpectedActions,
  baseUrl,
  apiKey,
  expectedModelId,
  modelMutationCheck,
}: {
  outcome: AIContentJobOutcome;
  mode: AIContentMode;
  contentName: string;
  unexpectedActions: string[];
  baseUrl: string;
  apiKey: string;
  expectedModelId: string;
  modelMutationCheck?: AIContentModelMutationCheck;
}) {
  const isCreationMode = mode === 'dashboard' || mode === 'app';
  const isCompletedHandoff = isCreationMode && outcome.resultAvailability === 'unavailable';
  const isReportedCreation = isCreationMode && outcome.artifactState === 'reported-created-unverified';
  const isCreationStatusUnverified = isCreationMode && outcome.artifactState === 'creation-status-unverified';
  const isChatHandoff = mode === 'review'
    || mode === 'report'
    || isCompletedHandoff
    || isReportedCreation
    || isCreationStatusUnverified
    || (mode === 'app' && outcome.artifactState === 'returned-unverified');
  const canAuthoritativelyReconcileDashboard = mode === 'dashboard'
    && Boolean(contentName.trim())
    && Boolean(expectedModelId.trim());
  const dashboardScopeUnavailableAfterRestore = mode === 'dashboard'
    && outcome.artifactState !== 'not-returned'
    && !canAuthoritativelyReconcileDashboard;
  const narrative = parseAIContentNarrative(outcome.message, mode);
  const HeadingIcon = mode === 'review' ? ShieldCheck : isCompletedHandoff ? CircleCheck : AlertTriangle;
  const structureOnlyReview = unexpectedActions.length > 0
    && unexpectedActions.every((issue) => /^(?:REVIEW|REPORT)_STRUCTURE:/i.test(issue.trim()));
  const actionReviewCopy = mode === 'report'
    ? 'Omni returned incomplete, unrecognized, truncated, potentially mutating, or otherwise unsafe action evidence. Inspect this exact report job and its returned action history in Omni Chat before relying on or sharing the narrative.'
    : mode === 'review'
      ? 'Omni returned incomplete, unrecognized, truncated, potentially mutating, or otherwise unsafe action evidence. Inspect this exact review job and its returned action history in Omni Chat before relying on or sharing the review.'
      : 'Omni returned malformed, unrecognized, truncated, potentially mutating, or otherwise unsafe response evidence. Inspect the Omni chat and resulting artifacts before continuing.';
  const modelSnapshotLimit = mode === 'report'
    ? ' This does not verify the report values, query results, or returned action history.'
    : mode === 'review'
      ? ' This does not verify the review findings, dashboard behavior, or returned action history.'
      : isCreationMode
        ? ' This does not verify artifact existence, data correctness, runtime behavior, or returned action history.'
        : '';

  return (
    <div className="card space-y-4 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <HeadingIcon size={18} className={mode === 'review' || isCompletedHandoff ? 'text-emerald-700' : 'text-amber-700'} />
            <h2 className="text-sm font-semibold text-content-primary">{resultHeading(mode, outcome.artifactState, outcome.resultAvailability)}</h2>
          </div>
          {outcome.jobId
            ? <div className="mt-1 text-[11px] font-mono text-content-tertiary">Job {outcome.jobId}</div>
            : <div className="mt-1 text-[11px] text-content-tertiary">Validated AI response</div>}
        </div>
        {outcome.chatUrl && (
          <a href={outcome.chatUrl} target="_blank" rel="noopener noreferrer" className={`${isChatHandoff ? 'btn-primary' : 'btn-secondary'} text-xs`}>
            <ExternalLink size={13} /> {isChatHandoff ? 'Continue in Omni Chat' : 'Open Omni chat'}
          </a>
        )}
      </div>

      {isCompletedHandoff && (
        <div className="rounded-card border border-emerald-200 bg-emerald-50 p-3 text-xs leading-5 text-emerald-950">
          <strong>Omni confirmed the job as COMPLETE.</strong> The separate structured result is unavailable in OmniKit, so this confirms job completion—not that the requested artifact exists or satisfies the brief. Continue in Omni Chat to inspect and refine the result.
        </div>
      )}

      {unexpectedActions.length > 0 && (
        <div role="alert" className="rounded-card border border-red-200 bg-red-50 p-3 text-xs leading-5 text-red-800">
          <strong>{structureOnlyReview ? 'Response review required:' : 'Action review required:'}</strong>{' '}
          {structureOnlyReview
            ? 'The completed narrative did not match the requested response structure. Inspect the full response in Omni Chat before relying on or sharing it.'
            : actionReviewCopy}
          <ul className="mt-2 list-disc pl-5">{unexpectedActions.map((action) => <li key={action}>{action}</li>)}</ul>
        </div>
      )}

      {modelMutationCheck && (
        <div className={`rounded-card border p-3 text-xs leading-5 ${modelMutationCheck.status === 'unchanged' ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-red-200 bg-red-50 text-red-900'}`}>
          <strong>{modelMutationCheck.status === 'unchanged' ? 'Scoped model snapshot unchanged' : 'Model postcondition review required'}</strong>
          {modelMutationCheck.status === 'unchanged' ? (
            <p className="mt-1">The selected main-model YAML/checksum hash and active branch identifiers matched the pre-run snapshot. This scoped equality is not proof that no unrelated tenant content changed.{modelSnapshotLimit}</p>
          ) : (
            <ul className="mt-2 list-disc space-y-1 pl-5">{modelMutationCheck.issues.map((issue) => <li key={issue}>{issue}</li>)}</ul>
          )}
        </div>
      )}

      {isCreationMode && outcome.artifactState === 'not-returned' && !isCompletedHandoff && (
        <div className="rounded-card border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900">
          <strong>Omni returned no artifact reference.</strong> This can be a deliberate preflight stop or a completed response without a documented identifier. Read the outcome and Omni chat before changing the governed scope or submitting another request. OmniKit has not verified that an artifact exists.
        </div>
      )}

      {isReportedCreation && (
        <div className="rounded-card border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900">
          <strong>Omni returned the expected creation action without a verifiable artifact identifier.</strong>{' '}
          The AI job completed and reported that it built the requested {mode === 'app' ? 'App' : 'dashboard'}, but OmniKit cannot prove that claim from prose alone. Continue in Omni Chat and reconcile the exact artifact {mode === 'dashboard' && canAuthoritativelyReconcileDashboard ? 'below' : 'in Omni'} before relying on it or starting another creation job.
        </div>
      )}

      {isCreationStatusUnverified && (
        <div className="rounded-card border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900">
          <strong>Omni completed the job, but its creation status is unverified.</strong>{' '}
          The returned action evidence was incomplete, unknown, or potentially mutating, so OmniKit cannot determine whether the requested {mode === 'app' ? 'App' : 'dashboard'} was created. Inspect this exact job and its action history in Omni before relying on the result or starting another creation job.
        </div>
      )}

      {dashboardScopeUnavailableAfterRestore && (
        <div className="rounded-card border border-blue-200 bg-blue-50 p-3 text-xs leading-5 text-blue-900">
          <strong>Local verification is unavailable after session restore.</strong>{' '}
          OmniKit intentionally does not persist the requested dashboard name or model scope in the reconciliation hold. Inspect this exact job and artifact in Omni Chat, then use the acknowledgement above to clear the duplicate-safety hold.
        </div>
      )}

      {isCreationMode && outcome.artifactState === 'returned-unverified' && (
        <div className="rounded-card border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900">
          The Agent response alone does not prove that <strong>{contentName || 'the requested artifact'}</strong> exists or matches the requested type, model, destination, queries, filters, ownership, or permissions. Reconcile the exact identifier {mode === 'dashboard' && !canAuthoritativelyReconcileDashboard ? 'in Omni' : 'below'} before relying on it.
        </div>
      )}

      {outcome.documentReferences.length > 0 && (
        <div className="rounded-card border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
          <div className="font-semibold">Unverified returned document references</div>
          {outcome.documentReferences.map((evidence) => (
            <div key={`${evidence.actionType}-${evidence.documentId}`} className="mt-1 font-mono break-all">
              {evidence.actionType}: {evidence.documentId}
            </div>
          ))}
        </div>
      )}

      {isCreationMode && (
        <div className="rounded-card border border-blue-200 bg-blue-50 p-3 text-xs leading-5 text-blue-950" role="note">
          <strong>Omni-reported — not independently verified</strong>
          <p className="mt-1">
            The response below may describe creation, query results, checks, or runtime behavior that OmniKit has not independently reproduced. Treat it as the Agent&apos;s report until the exact {mode === 'app' ? 'App and paired workbook are' : 'dashboard is'} reconciled in Omni.
          </p>
        </div>
      )}

      {narrative.sections.length > 0 ? (
        <div className="grid gap-3">
          {narrative.sections.map((section) => (
            <section
              key={section.key}
              aria-labelledby={`ai-content-section-${section.key}`}
              className={`rounded-card border p-4 ${section.evidenceLimit ? 'border-amber-200 bg-amber-50/70' : 'border-border bg-white'}`}
            >
              <h3 id={`ai-content-section-${section.key}`} className="text-sm font-semibold text-content-primary">{section.heading}</h3>
              <div className="mt-2"><MarkdownLite value={section.body} headingLevel={4} /></div>
            </section>
          ))}
        </div>
      ) : (
        <div className="rounded-card border border-border bg-white p-4">
          <MarkdownLite value={narrative.raw} />
        </div>
      )}

      {outcome.actionSummaries.length > 0 && (
        <details className="rounded-card border border-border bg-surface-secondary p-3 text-xs">
          <summary className="cursor-pointer font-semibold text-content-primary">Omni action summary ({outcome.actionSummaries.length})</summary>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-content-secondary">
            {outcome.actionSummaries.map((action, index) => <li key={`${index}-${action}`}>{action}</li>)}
          </ul>
        </details>
      )}

      {!isCompletedHandoff && (canAuthoritativelyReconcileDashboard || (mode === 'app' && outcome.artifactState !== 'not-returned')) && (
        <ArtifactReconciliationPanel
          baseUrl={baseUrl}
          apiKey={apiKey}
          mode={mode}
          expectedName={contentName}
          expectedModelId={expectedModelId}
          references={outcome.documentReferences}
        />
      )}
    </div>
  );
}
