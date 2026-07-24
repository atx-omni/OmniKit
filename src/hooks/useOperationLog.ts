import { useCallback, useContext } from 'react';
import type { OperationType } from '@/types';
import { sanitizeOperationDetails } from '@/services/historyExport';
import { OperationLogContext } from '@/contexts/operationLogContextValue';

export function useOperationLog() {
  const context = useContext(OperationLogContext);
  if (!context) throw new Error('useOperationLog must be used within OperationLogProvider');
  return context;
}

export function useLogOperation() {
  const { addEntry } = useOperationLog();

  return useCallback(
    (
      type: OperationType,
      description: string,
      options: {
        itemCount?: number;
        successCount?: number;
        failureCount?: number;
        durationMs?: number;
        details?: Record<string, unknown>;
      } = {},
    ) => {
      addEntry({
        type,
        description,
        itemCount: options.itemCount ?? 1,
        successCount: options.successCount ?? 1,
        failureCount: options.failureCount ?? 0,
        durationMs: options.durationMs ?? 0,
        details: sanitizeOperationDetails(options.details),
      });
    },
    [addEntry],
  );
}

export type { OperationType };
