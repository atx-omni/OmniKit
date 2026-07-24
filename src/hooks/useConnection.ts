import { useContext } from 'react';
import { ConnectionContext } from '@/contexts/connectionContextValue';

export function useConnection() {
  const context = useContext(ConnectionContext);
  if (!context) throw new Error('useConnection must be used within ConnectionProvider');
  return context;
}
