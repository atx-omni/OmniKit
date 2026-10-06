import { useState } from 'react';
import { DashboardRepairFileDiff } from '@/components/dashboardMigration/DashboardTopicRepairReview';
import type { TopicMigrationFile, TopicMigrationPlan, TopicMigrationRequest } from '../../../shared/topicMigration';

const action = { create: 'New file', add: 'Additions', reuse: 'Already present', blocked: 'Conflict' };

export function TopicMigrationReview({ plan }: { plan: TopicMigrationPlan }) {
  const [search, setSearch] = useState('');
  const [showUnchanged, setShowUnchanged] = useState(false);
  const files = plan.files.filter(file => (showUnchanged || file.status !== 'reuse')
    && [file.sourceFileName, file.fileName, file.destinationFileName || ''].some(name => name.toLowerCase().includes(search.toLowerCase())));
  return <section className="space-y-3" aria-label="Proposed topic changes">
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{(['create', 'add', 'reuse', 'blocked'] as const).map(status => <div className="rounded-card border border-border p-3" key={status}><p className="text-xl font-semibold">{plan.files.filter(file => file.status === status).length}</p><p className="text-sm text-content-secondary">{action[status]}</p></div>)}</div>
    <label className="block text-sm">Find a change<input className="input-field mt-1 w-full" value={search} onChange={event => setSearch(event.target.value)} placeholder="View, topic, or file name" /></label>
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={showUnchanged} onChange={event => setShowUnchanged(event.target.checked)} />Show unchanged definitions</label>
    {files.map(file => <TopicMigrationFileReview file={file} key={file.fileName} />)}
    {!files.length && <p className="text-sm text-content-secondary">No changes match this filter. Filtering does not change migration scope.</p>}
    <details className="rounded-card border border-border p-3"><summary className="cursor-pointer text-sm font-semibold">Included automatically · {plan.dependencies.length} dependencies</summary>
      <ul className="mt-3 space-y-3">{plan.dependencies.map(item => <li key={item.fileName} className="text-sm"><p className="break-all font-medium">{item.fileName}</p><p className="text-content-secondary">{item.reasons.join(' · ')}</p><p className="text-xs text-content-tertiary">Required by {item.topicIds.map(id => plan.topics.find(topic => topic.id === id)?.name || id).join(', ')}</p></li>)}</ul>
    </details>
  </section>;
}

function TopicMigrationFileReview({ file }: { file: TopicMigrationFile }) {
  const [open, setOpen] = useState(false);
  const destinationFileName = file.destinationFileName || file.fileName;
  return <details className="rounded-card border border-border p-3" onToggle={event => setOpen(event.currentTarget.open)}><summary className="cursor-pointer text-sm"><span className="font-semibold">{action[file.status]}</span> · <span className="break-all">{file.sourceFileName}{file.sourceFileName !== destinationFileName && <> → {destinationFileName}</>}</span></summary>
    {file.sourceFileName !== destinationFileName && <p className="mt-2 break-all text-xs text-content-secondary">Source path → destination path. This path mapping is part of the exact reviewed package.</p>}
    {open && <div className="mt-3"><DashboardRepairFileDiff before={file.before} after={file.proposed} /></div>}
  </details>;
}

export function TopicMigrationScopeSummary({ request, sourceLabel, targetLabel }: { request: TopicMigrationRequest; sourceLabel?: string; targetLabel?: string }) {
  return <section className="rounded-card border border-border p-4" aria-label="Exact preparation scope">
    <h3 className="text-sm font-semibold">Confirm the exact source and destination</h3>
    <div className="mt-3 grid gap-4 md:grid-cols-2">{(['source', 'target'] as const).map(side => <div key={side} className="min-w-0 text-sm">
      <h4 className="font-semibold">{side === 'source' ? 'Source' : 'Destination'}</h4>
      <dl className="mt-1 space-y-1 break-all"><div><dt className="inline text-content-secondary">Instance: </dt><dd className="inline">{side === 'source' ? sourceLabel : targetLabel} <span className="text-xs">{request[`${side}InstanceId`]}</span></dd></div>
        <div><dt className="inline text-content-secondary">Connection ID: </dt><dd className="inline">{request[`${side}ConnectionId`]}</dd></div>
        <div><dt className="inline text-content-secondary">Model ID: </dt><dd className="inline">{request[`${side}ModelId`]}</dd></div></dl>
    </div>)}</div>
  </section>;
}
