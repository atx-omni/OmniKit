import { createContext } from 'react';
import type { ConnectionConfig, ConnectionStatus } from '@/types';

export interface ConnectionContextValue {
  connection: ConnectionConfig;
  isConnected: boolean;
  updateConnection: (payload: Partial<ConnectionConfig>) => void;
  resetConnection: () => void;
  setStatus: (status: ConnectionStatus, errorMessage?: string) => void;
}

export const ConnectionContext = createContext<ConnectionContextValue | null>(null);
