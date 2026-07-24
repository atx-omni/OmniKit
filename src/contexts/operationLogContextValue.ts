import { createContext } from 'react';
import type { OperationLogEntry } from '@/types';

export interface OperationLogContextValue {
  entries: OperationLogEntry[];
  addEntry: (entry: Omit<OperationLogEntry, 'id' | 'timestamp'>) => void;
  clearLog: () => void;
}

export const OperationLogContext = createContext<OperationLogContextValue | null>(null);
