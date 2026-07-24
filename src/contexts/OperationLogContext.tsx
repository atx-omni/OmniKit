import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { OperationLogEntry } from '@/types';
import { clearStore, getAllRecords, putRecord } from '@/services/localStore';
import { OperationLogContext } from './operationLogContextValue';

let entryCounter = 0;

const MAX_ENTRIES = 500;

export function OperationLogProvider({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<OperationLogEntry[]>([]);

  useEffect(() => {
    getAllRecords<OperationLogEntry>('operations_log')
      .then((rows) => {
        const sorted = [...rows].sort((a, b) => b.timestamp - a.timestamp).slice(0, MAX_ENTRIES);
        setEntries(sorted);
      })
      .catch(() => {
        // IndexedDB unavailable; continue in-memory only
      });
  }, []);

  const addEntry = useCallback((entry: Omit<OperationLogEntry, 'id' | 'timestamp'>) => {
    entryCounter += 1;
    const newEntry: OperationLogEntry = {
      ...entry,
      id: `op-${Date.now()}-${entryCounter}`,
      timestamp: Date.now(),
    };
    setEntries((prev) => [newEntry, ...prev].slice(0, MAX_ENTRIES));
    putRecord('operations_log', newEntry).catch(() => {
      // best-effort persistence
    });
  }, []);

  const clearLog = useCallback(() => {
    setEntries([]);
    clearStore('operations_log').catch(() => {
      // ignore
    });
  }, []);

  return (
    <OperationLogContext.Provider value={{ entries, addEntry, clearLog }}>
      {children}
    </OperationLogContext.Provider>
  );
}
