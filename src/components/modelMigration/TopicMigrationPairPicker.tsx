import { useEffect, useState } from 'react';
import { ComboBox } from '@/components/ui/ComboBox';
import { listModelMigratorConnections, listModelMigratorModels, type InstanceModel, type ModelMigratorConnection, type SavedInstancePublic } from '@/services/opsConsole';

export interface TopicMigrationSide { instanceId: string; connectionId: string; modelId: string }

export function TopicMigrationPairPicker({ label, value, instances, disabled, onChange }: {
  label: 'Source' | 'Destination'; value: TopicMigrationSide; instances: SavedInstancePublic[];
  disabled: boolean; onChange: (value: TopicMigrationSide) => void;
}) {
  const [connections, setConnections] = useState<ModelMigratorConnection[]>([]);
  const [models, setModels] = useState<InstanceModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [error, setError] = useState('');
  const [modelError, setModelError] = useState('');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setConnections([]); setError('');
    if (!value.instanceId) { setLoading(false); return; }
    setLoading(true);
    listModelMigratorConnections(value.instanceId, controller.signal).then(result => {
      if (!controller.signal.aborted) setConnections(result.connections.filter(row => !row.deletedAt));
    }).catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Connections could not be read.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [value.instanceId, reload]);
  useEffect(() => {
    const controller = new AbortController();
    setModels([]); setModelError('');
    if (!value.instanceId || !value.connectionId) { setModelsLoading(false); return; }
    setModelsLoading(true);
    listModelMigratorModels(value.instanceId, { connectionId: value.connectionId, signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) setModels(result.models.filter(row => !row.deletedAt && row.connectionId === value.connectionId));
    }).catch(reason => { if (!controller.signal.aborted) setModelError(reason instanceof Error ? reason.message : 'Models could not be read.'); })
      .finally(() => { if (!controller.signal.aborted) setModelsLoading(false); });
    return () => controller.abort();
  }, [value.instanceId, value.connectionId, reload]);
  const selected = connections.find(row => row.id === value.connectionId);
  return <section className="card space-y-4 p-5" aria-label={`${label} selection`}>
    <h2 className="font-semibold">{label}</h2>
    <div><p className="mb-1 text-sm">Instance</p><ComboBox ariaLabel={`${label} instance`} allowFreeText={false} placeholder={`Choose ${label.toLowerCase()} instance`} disabled={disabled}
      value={value.instanceId} options={instances.map(row => ({ value: row.id, label: `${row.label} · ${row.baseUrl}` }))}
      onChange={instanceId => onChange({ instanceId, connectionId: '', modelId: '' })} /></div>
    <div><p className="mb-1 text-sm">Connection</p><ComboBox ariaLabel={`${label} connection`} allowFreeText={false} placeholder="Choose connection" disabled={disabled || !value.instanceId || loading}
      isLoading={loading} value={value.connectionId} options={connections.map(row => ({ value: row.id, label: `${row.name} · ${row.database}` }))}
      onChange={connectionId => onChange({ ...value, connectionId, modelId: '' })} /></div>
    <div><p className="mb-1 text-sm">Model</p><ComboBox ariaLabel={`${label} model`} allowFreeText={false} placeholder="Choose model" disabled={disabled || !value.connectionId || modelsLoading}
      isLoading={modelsLoading} value={value.modelId} options={models.map(row => ({ value: row.id, label: row.name }))}
      onChange={modelId => onChange({ ...value, modelId })} /></div>
    {selected && <p className="text-sm text-content-secondary">{selected.dialect || 'Dialect not available'} · {models.find(row => row.id === value.modelId)?.name || 'Select a model to continue'}</p>}
    {(error || modelError) && <div role="alert"><p className="text-sm text-red-700">{error || modelError}</p><button className="btn-secondary mt-2" disabled={disabled || loading || modelsLoading} onClick={() => setReload(current => current + 1)}>Reload choices</button></div>}
    {!modelsLoading && value.connectionId && !modelError && !models.length && <p className="text-sm text-content-secondary">No shared models were returned for this connection.</p>}
  </section>;
}
