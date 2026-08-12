import { useEffect, useId, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { ChevronDown, Clock, KeyRound, Loader2, Lock, Server, ShieldCheck, UnlockKeyhole } from 'lucide-react';
import { PassphraseInput } from '@/components/ui/PassphraseInput';
import { useConnection } from '@/hooks/useConnection';
import { useVaultSession } from '@/hooks/useVaultSession';
import { hasSavedVaultConnection } from '@/services/connectionGuards';

const PRIMARY_ACTION_CLASS = 'flex min-h-9 w-full items-center justify-center gap-2 rounded-[6px] bg-brand-wine px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-brand-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-wine disabled:cursor-not-allowed disabled:opacity-50';
const SECONDARY_ACTION_CLASS = 'flex min-h-9 w-full items-center justify-center gap-2 rounded-[6px] border border-border-strong bg-surface-primary px-3 py-2 text-xs font-semibold text-omni-900 transition-colors hover:border-brand-wine hover:bg-surface-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-wine';

function formatRemaining(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return minutes > 0 ? `${minutes}m ${remainingSeconds}s` : `${remainingSeconds}s`;
}

function roleLabel(role: string): string {
  if (role === 'both') return 'Source + destination';
  return role === 'source' ? 'Source' : 'Destination';
}

function isRecentlyValidated(value?: string): boolean {
  if (!value) return false;
  const validatedAt = Date.parse(value);
  if (!Number.isFinite(validatedAt)) return false;
  return Date.now() - validatedAt < 24 * 60 * 60 * 1000;
}

function validationLabel(value?: string): string {
  if (!value) return 'Not tested recently';
  const validatedAt = Date.parse(value);
  if (!Number.isFinite(validatedAt)) return 'Validation age unknown';
  return isRecentlyValidated(value) ? 'Tested in the last 24h' : 'Test again recommended';
}

export function InstanceSwitcher() {
  const { connection } = useConnection();
  const {
    status,
    vaultStatus,
    instances,
    loading,
    lockedMessage,
    unlock,
    connectInstance,
    touch,
  } = useVaultSession();
  const panelId = useId();
  const passphraseInputId = `${panelId}-passphrase`;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!vaultStatus?.unlocked) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [vaultStatus?.unlocked]);

  useEffect(() => {
    if (lockedMessage) setOpen(true);
  }, [lockedMessage]);

  const activeInstance = useMemo(
    () => instances.find((instance) => instance.id === connection.instanceId),
    [connection.instanceId, instances],
  );
  const remainingMs = vaultStatus?.unlocked && vaultStatus.idleTimeoutMs && vaultStatus.lastActivityAt
    ? vaultStatus.lastActivityAt + vaultStatus.idleTimeoutMs - now
    : null;
  const showIdleWarning = remainingMs !== null && remainingMs > 0 && remainingMs < 5 * 60 * 1000;
  const canUnlockVault = Boolean(passphrase.trim()) && Boolean(vaultStatus?.exists) && !busy;
  const hasSavedConnection = hasSavedVaultConnection(connection);
  const statusLabel = status === 'unlocked'
    ? 'Vault unlocked'
    : status === 'no-vault'
      ? 'Setup needed'
      : status === 'unknown'
        ? 'Checking vault'
        : 'Vault locked';

  async function handleConnect(instanceId: string) {
    if (instanceId === connection.instanceId) {
      setOpen(false);
      return;
    }
    setBusy(true);
    setError('');
    try {
      await connectInstance(instanceId);
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not connect to this saved instance.');
    } finally {
      setBusy(false);
    }
  }

  async function handleExtend() {
    setBusy(true);
    setError('');
    try {
      await touch();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not extend the vault session.');
    } finally {
      setBusy(false);
    }
  }

  async function handleUnlock() {
    if (!canUnlockVault) return;
    setBusy(true);
    setError('');
    try {
      await unlock(passphrase);
      setPassphrase('');
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not unlock the vault.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-b border-border px-3 py-3">
      <div className="mb-1 flex items-center justify-between gap-2 px-2">
        <span className="text-[11px] font-semibold leading-4 tracking-normal text-content-tertiary">Omni instance</span>
        <span className={`text-[10px] font-medium ${status === 'unlocked' ? 'text-emerald-700' : 'text-content-tertiary'}`}>
          {statusLabel}
        </span>
      </div>

      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="group flex min-h-12 w-full items-center gap-2.5 rounded-[6px] px-2 py-2 text-left text-[12px] font-semibold text-omni-900 transition-colors hover:bg-surface-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-wine"
        aria-expanded={open}
        aria-controls={panelId}
        aria-busy={loading || busy}
      >
        <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-[6px] ${status === 'unlocked' ? 'bg-omni-50 text-omni-700' : 'bg-surface-tertiary text-content-secondary'}`}>
          {status === 'unlocked' ? <ShieldCheck size={15} aria-hidden="true" /> : <Lock size={15} aria-hidden="true" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate leading-4">
            {activeInstance?.label || connection.instanceLabel || (hasSavedConnection ? 'Saved instance' : 'Instance vault')}
          </span>
          <span className="mt-0.5 block truncate text-[10px] font-normal leading-4 text-content-secondary">
            {activeInstance
              ? `${roleLabel(activeInstance.role)} · ${activeInstance.apiKeyMasked}`
              : hasSavedConnection
                ? `${connection.apiKeyMasked || 'Vault key masked'} · saved profile`
                : status === 'unlocked'
                  ? `${instances.length} saved instance${instances.length === 1 ? '' : 's'}`
                  : status === 'no-vault'
                    ? 'Set up vault'
                    : 'Unlock to switch'}
          </span>
        </span>
        {loading ? (
          <Loader2 size={14} className="shrink-0 animate-spin text-content-secondary" aria-hidden="true" />
        ) : (
          <ChevronDown
            size={14}
            className={`shrink-0 text-content-secondary transition-transform ${open ? 'rotate-180' : ''}`}
            aria-hidden="true"
          />
        )}
      </button>

      {showIdleWarning && (
        <div className="mt-2 border-l-2 border-amber-400 bg-amber-50 px-2.5 py-2 text-[10px] text-amber-900" role="status">
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <Clock size={12} className="shrink-0" aria-hidden="true" />
              <span className="truncate">Locks in {formatRemaining(remainingMs)}</span>
            </span>
            <button
              type="button"
              onClick={handleExtend}
              disabled={busy}
              className="shrink-0 font-semibold text-amber-950 hover:underline disabled:cursor-not-allowed disabled:opacity-50"
            >
              Extend session
            </button>
          </div>
        </div>
      )}

      {open && (
        <div id={panelId} className="mt-2 space-y-2 border-t border-border pt-2 text-[12px]">
          {lockedMessage && (
            <div className="border-l-2 border-amber-400 bg-amber-50 px-2.5 py-2 text-[11px] text-amber-900" role="status">
              {lockedMessage}
            </div>
          )}
          {error && (
            <div className="border-l-2 border-red-500 bg-red-50 px-2.5 py-2 text-[11px] text-red-800" role="alert">
              {error}
            </div>
          )}

          {status === 'no-vault' ? (
            <Link to="/" className={PRIMARY_ACTION_CLASS}>
              <KeyRound size={14} aria-hidden="true" />
              Set up on Home
            </Link>
          ) : status === 'locked' || status === 'unknown' ? (
            <div className="space-y-2">
              <label htmlFor={passphraseInputId} className="block text-[11px] font-semibold text-content-secondary">
                Vault passphrase
              </label>
              <PassphraseInput
                id={passphraseInputId}
                value={passphrase}
                onChange={setPassphrase}
                onSubmit={() => {
                  if (canUnlockVault) void handleUnlock();
                }}
                disabled={busy || status === 'unknown'}
                inputClassName="h-9 text-xs"
                placeholder={status === 'unknown' ? 'Checking vault status...' : 'Enter vault passphrase'}
                autoComplete="current-password"
              />
              <button
                type="button"
                onClick={handleUnlock}
                disabled={!canUnlockVault}
                className={PRIMARY_ACTION_CLASS}
              >
                {busy ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <UnlockKeyhole size={14} aria-hidden="true" />}
                Unlock and resume
              </button>
              <Link to="/" className={SECONDARY_ACTION_CLASS}>
                <Lock size={14} aria-hidden="true" />
                Open Home
              </Link>
            </div>
          ) : (
            <div className="space-y-2">
              {instances.length === 0 ? (
                <Link to="/admin/fleet/instances" className={SECONDARY_ACTION_CLASS}>
                  <Server size={14} aria-hidden="true" />
                  Add saved instance
                </Link>
              ) : (
                <>
                  <div className="max-h-56 overflow-auto rounded-[6px] border border-border bg-surface-primary" role="group" aria-label="Saved Omni instances">
                    {instances.map((instance) => {
                      const active = instance.id === connection.instanceId;
                      const recent = isRecentlyValidated(instance.lastValidatedAt);
                      return (
                        <button
                          key={instance.id}
                          type="button"
                          onClick={() => void handleConnect(instance.id)}
                          disabled={busy}
                          className={`flex w-full items-start gap-2 border-b border-border-subtle border-l-[3px] px-2.5 py-2 text-left transition-colors last:border-b-0 ${
                            active
                              ? 'border-l-omni-500 bg-omni-50 text-omni-900 hover:bg-omni-100'
                              : 'border-l-transparent hover:bg-surface-secondary'
                          } disabled:cursor-wait disabled:opacity-70`}
                          aria-current={active ? 'true' : undefined}
                        >
                          <span
                            className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${recent ? 'bg-success' : 'bg-border-strong'}`}
                            title={validationLabel(instance.lastValidatedAt)}
                            aria-hidden="true"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-semibold text-omni-900">{instance.label}</span>
                            <span className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5">
                              <span className="shrink-0 rounded-full bg-surface-tertiary px-1.5 py-0.5 text-[9px] font-semibold tracking-normal text-content-secondary">
                                {roleLabel(instance.role)}
                              </span>
                              {active && (
                                <span className="shrink-0 rounded-full bg-white px-1.5 py-0.5 text-[9px] font-semibold tracking-normal text-omni-700 ring-1 ring-omni-200">
                                  Active
                                </span>
                              )}
                            </span>
                            <span className="mt-0.5 block truncate text-[10px] text-content-secondary">
                              {instance.apiKeyMasked}
                            </span>
                            <span className="mt-0.5 block truncate text-[10px] text-content-tertiary">
                              {validationLabel(instance.lastValidatedAt)}
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  <Link to="/admin/fleet/instances" className={SECONDARY_ACTION_CLASS}>
                    <Server size={14} aria-hidden="true" />
                    Manage instances
                  </Link>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
