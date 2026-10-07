import { useState } from 'react';
import { canChooseTopicDestinationDefinitions, groupTopicMigrationIssues } from '@/services/topicMigrationFlow';
import { DashboardRepairFileDiff } from '@/components/dashboardMigration/DashboardTopicRepairReview';
import type { TopicMigrationIssue, TopicMigrationPlan, TopicMigrationRequest } from '../../../shared/topicMigration';

export function TopicMigrationIssues({ issues, plan, request, disabled, onChange }: {
  issues: TopicMigrationIssue[]; plan: TopicMigrationPlan; request: TopicMigrationRequest; disabled: boolean;
  onChange: (request: TopicMigrationRequest) => void;
}) {
  return <div className="space-y-3">{groupTopicMigrationIssues(issues).map(group => <IssueGroup key={`${plan.revision}:${group.id}`} group={group} plan={plan} request={request} disabled={disabled} onChange={onChange} />)}</div>;
}

function IssueGroup({ group, plan, request, disabled, onChange }: {
  group: ReturnType<typeof groupTopicMigrationIssues>[number]; plan: TopicMigrationPlan; request: TopicMigrationRequest;
  disabled: boolean; onChange: (request: TopicMigrationRequest) => void;
}) {
  const [showDiff, setShowDiff] = useState(false);
  const file = plan.files.find(row => row.sourceFileName === group.fileName || row.fileName === group.fileName);
  const topicIds = [...new Set(group.issues.flatMap(issue => issue.topicIds))];
  const blocking = group.issues.some(issue => issue.severity === 'blocker');
  const informational = group.issues.every(issue => issue.severity === 'info');
  return <section className={`card space-y-3 border-l-4 p-4 ${blocking ? 'border-l-amber-600' : 'border-l-border'}`} aria-label={`${group.title}${group.fileName ? ` · ${group.fileName}` : ''}`}>
    <div><h3 className="font-semibold">{group.title}</h3>{group.fileName && <p className="break-all text-sm text-content-secondary">{group.fileName}</p>}</div>
    <p className="text-sm">{group.issues.length} {group.issues.length === 1 ? 'finding' : 'findings'} · {blocking ? 'Resolve before preparing a branch' : informational ? 'For your review' : 'Finish in Omni — does not block branch preparation'}</p>
    <p className="text-sm font-medium">{group.sql && !blocking ? (plan.sqlDialectPolicy
      ? 'Review the proposed identifier fixes and unchanged expressions. Dialect checks are limited; validate SQL and query results in Omni before publishing.'
      : 'SQL is preserved, not automatically translated. Check syntax, tables, and query results on the review branch in Omni before publishing.') : group.issues[0].nextAction}</p>
    <p className="text-xs text-content-secondary">Affects {topicIds.map(id => plan.topics.find(topic => topic.id === id)?.name || id).join(', ') || 'the selected migration'}</p>
    {blocking && file && canChooseTopicDestinationDefinitions(plan, file) && <p className="rounded border border-border p-3 text-sm">This view has an explicit option to keep destination definitions and add only missing items. Open this view’s file comparison below, inspect the differences, and choose that option to recheck. Other conflicts still require resolution.</p>}
    <details><summary className="cursor-pointer text-sm">Technical details and affected fields</summary>
      <ul className="mt-3 max-h-96 space-y-3 overflow-auto text-sm">{group.issues.map(issue => <li className="rounded border border-border p-3" key={issue.id}>
        <h4 className="break-words font-medium">{issue.title}</h4><p>{issue.message}</p><p className="mt-1 text-xs text-content-secondary">{issue.nextAction}</p>
      </li>)}</ul>
    </details>
    {group.sql && file && <details onToggle={event => setShowDiff(event.currentTarget.open)}><summary className="cursor-pointer text-sm font-medium">Review full file differences</summary>{showDiff && <div className="mt-3"><DashboardRepairFileDiff before={file.before} after={file.proposed} /></div>}</details>}
    {blocking && topicIds.length > 0 && <button className="btn-secondary text-sm" disabled={disabled} onClick={() => onChange({ ...request, topicIds: request.topicIds.filter(id => !topicIds.includes(id)) })}>Hold affected topics and review remaining scope</button>}
  </section>;
}
