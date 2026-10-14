import { useState, type ReactNode } from 'react';
import type { ModelMigratorTranslatedFile } from '@/services/opsConsole';
import { ordinaryModelFileReview } from '@/services/modelMigrationFileReview';

interface Props {
  files: ModelMigratorTranslatedFile[];
  accepted: Record<string, string>;
  edited?: Record<string, string>;
  skipped: string[];
  dashboardRepair?: boolean;
  children: (file: ModelMigratorTranslatedFile) => ReactNode;
}

export function ModelMigrationFileList({ files, accepted, edited = {}, skipped, dashboardRepair = false, children }: Props) {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const fileStatus = (file: ModelMigratorTranslatedFile) => dashboardRepair
    ? skipped.includes(file.fileName) ? 'skipped' : accepted[file.fileName] !== undefined ? 'accepted' : file.additiveStatus === 'unchanged' ? 'unchanged' : 'pending'
    : ordinaryModelFileReview(file, { accepted: accepted[file.fileName], edited: edited[file.fileName], skipped: skipped.includes(file.fileName) }).status;
  const pending = files.filter((file) => fileStatus(file) === 'pending').length;
  const acceptedCount = files.filter((file) => fileStatus(file) === 'accepted').length;
  const skippedCount = files.filter((file) => fileStatus(file) === 'skipped').length;
  const unchangedCount = files.filter((file) => fileStatus(file) === 'unchanged').length;
  const visible = files.filter((file) => file.fileName.toLowerCase().includes(search.trim().toLowerCase())
    && (status === 'all' || fileStatus(file) === status));
  return <section aria-label="File review" className="space-y-2">
    <p className="text-xs text-content-secondary">{files.length} files · {pending} need review · {acceptedCount} accepted · {skippedCount} skipped · {unchangedCount} unchanged. Unchanged files need no acceptance and will not be written. Open a changed file to inspect its destination diff before accepting it. Filtering does not accept or skip files.</p>
    <div className="grid gap-2 sm:grid-cols-2">
      <label className="text-xs">Find a model file<input className="input-field mt-1" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="File or folder name" /></label>
      <label className="text-xs">File review status<select className="input-field mt-1" value={status} onChange={(event) => setStatus(event.target.value)}>
        <option value="all">All files</option><option value="pending">Needs review</option><option value="accepted">Accepted</option><option value="skipped">Skipped</option><option value="unchanged">Unchanged</option>
      </select></label>
    </div>
    {visible.length ? visible.map(children) : <p className="text-xs text-content-secondary">No files match these filters. Clear the search or choose All files.</p>}
  </section>;
}
