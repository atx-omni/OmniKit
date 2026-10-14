import type { TopicMigrationFile } from '../../shared/topicMigration';
import { readTopicTableNameInventory, topicMigrationPhysicalTable, type TopicTableNameInventory } from './topicMigrationTableNames';

const MAX_NAMESPACES = 20;
const MAX_CONCURRENT_READS = 4;

/** Optional schema-name evidence, bounded by the selected topic dependencies, never by the whole connection. */
export async function readTopicMigrationTableNameEvidence(
  files: Pick<TopicMigrationFile, 'kind' | 'fileName' | 'proposed'>[],
  readSchema: (namespace: string, signal: AbortSignal) => Promise<{ files: Record<string, string> }>,
  signal?: AbortSignal,
  options: { includeColumns?: boolean } = {},
): Promise<TopicTableNameInventory[]> {
  signal?.throwIfAborted();
  const namespaces = [...new Set(files.flatMap(file => {
    if (file.kind !== 'view' || file.fileName.endsWith('.query.view')) return [];
    const reference = topicMigrationPhysicalTable(file.proposed);
    return reference ? [reference.namespace] : [];
  }))].sort();
  const inventories: TopicTableNameInventory[] = namespaces.map(namespace => ({ namespace, status: 'unavailable', tableNames: [] }));
  const deadline = AbortSignal.timeout(15_000);
  const readSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let next = 0;
  async function worker() {
    while (next < Math.min(namespaces.length, MAX_NAMESPACES) && !readSignal.aborted) {
      const index = next++;
      try {
        const response = await readSchema(namespaces[index], readSignal);
        inventories[index] = readTopicTableNameInventory(namespaces[index], response.files, options.includeColumns);
      } catch {
        // Incomplete metadata is a review warning, never evidence that a table is absent.
        signal?.throwIfAborted();
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(namespaces.length, MAX_CONCURRENT_READS) }, worker));
  signal?.throwIfAborted();
  return inventories;
}
