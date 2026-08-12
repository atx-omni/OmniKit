import { useLayoutEffect, useRef, useState } from 'react';
import { Link2, Copy, Check, ExternalLink } from 'lucide-react';
import { generateEmbedUrl } from '@/services/omniApi';
import { useConnection } from '@/hooks/useConnection';
import { useConnectionRequestGuard } from '@/hooks/useConnectionRequestGuard';
import { DashboardSearch } from '@/components/deckBuilder/DashboardSearch';
import { PageHeader } from '@/components/layout/PageHeader';
import { Blobby } from '@/components/ui/Blobby';
import { fetchDashboardList } from '@/services/deckBuilder/omniDeckApi';
import { dashboardCache, type CachedDashboard } from '@/services/deckBuilder/localCache';
import { friendlyApiError } from '@/utils/apiErrors';
import { AdminReadinessPanel } from '@/components/admin/CapabilityStatus';

function dashboardContentPath(dashboard: CachedDashboard) {
  return `/dashboards/${dashboard.id}`;
}

export function EmbedsPage() {
  const { connection } = useConnection();
  const { connectionKey, isActiveConnectionRequest } = useConnectionRequestGuard(connection);
  const [contentPath, setContentPath] = useState('');
  const [selectedDashboardId, setSelectedDashboardId] = useState('');
  const [dashboards, setDashboards] = useState<CachedDashboard[]>([]);
  const [dashboardsSyncedAt, setDashboardsSyncedAt] = useState<number | null>(null);
  const [loadingDashboards, setLoadingDashboards] = useState(false);
  const [externalId, setExternalId] = useState('');
  const [name, setName] = useState('');
  const [embedSecret, setEmbedSecret] = useState('');
  const [email, setEmail] = useState('');
  const [groups, setGroups] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const generationRevisionRef = useRef(0);

  useLayoutEffect(() => {
    generationRevisionRef.current += 1;
    const cached = dashboardCache.load(connectionKey);
    if (cached?.data) {
      setDashboards(cached.data);
      setDashboardsSyncedAt(cached.savedAt);
    } else {
      setDashboards([]);
      setDashboardsSyncedAt(null);
    }
    setSelectedDashboardId('');
    setContentPath('');
    setEmbedSecret('');
    setExternalId('');
    setName('');
    setEmail('');
    setGroups('');
    setResult(null);
    setError('');
    setCopied(false);
    setLoading(false);
    setLoadingDashboards(false);
  }, [connectionKey]);

  function invalidateGeneratedUrl() {
    generationRevisionRef.current += 1;
    setResult(null);
    setCopied(false);
  }

  async function refreshDashboards() {
    const requestKey = connectionKey;
    setLoadingDashboards(true);
    setError('');
    try {
      const next = await fetchDashboardList(connection.baseUrl, connection.apiKey);
      if (!isActiveConnectionRequest(requestKey)) return;
      setDashboards(next);
      setDashboardsSyncedAt(Date.now());
      dashboardCache.save(connectionKey, next);
    } catch (err) {
      if (!isActiveConnectionRequest(requestKey)) return;
      setError(friendlyApiError(err, 'Failed to load dashboards'));
    } finally {
      if (isActiveConnectionRequest(requestKey)) setLoadingDashboards(false);
    }
  }

  function pickDashboard(dashboard: CachedDashboard) {
    if (loading) return;
    setSelectedDashboardId(dashboard.id);
    setContentPath(dashboardContentPath(dashboard));
    invalidateGeneratedUrl();
  }

  async function handleGenerate(e: React.FormEvent) {
    e.preventDefault();
    const requestKey = connectionKey;
    const generationRevision = generationRevisionRef.current;
    setLoading(true);
    setError('');
    setResult(null);

    try {
      if (!contentPath.trim() || !externalId.trim() || !name.trim() || !embedSecret.trim()) {
        setError('Content path, external ID, name, and embed secret are required.');
        return;
      }
      const body: Record<string, unknown> = {
        contentPath: contentPath.trim(),
        externalId: externalId.trim(),
        name: name.trim(),
        email: email || undefined,
      };
      if (groups) {
        body.groups = groups.split(',').map((g) => g.trim()).filter(Boolean);
      }

      const res = await generateEmbedUrl(connection.baseUrl, embedSecret, body);
      if (!isActiveConnectionRequest(requestKey) || generationRevisionRef.current !== generationRevision) return;
      const url = typeof res?.url === 'string' ? res.url : '';
      if (!url) throw new Error('Omni returned no signed embed URL.');
      setResult(url);
    } catch (err) {
      if (!isActiveConnectionRequest(requestKey)) return;
      setError(friendlyApiError(err, 'Failed to generate embed URL'));
    } finally {
      if (isActiveConnectionRequest(requestKey)) {
        setEmbedSecret('');
        setLoading(false);
      }
    }
  }

  async function copyText(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      setError(friendlyApiError(err, 'Unable to copy URL'));
    }
  }

  function handleCopy() {
    if (result) {
      copyText(result);
    }
  }

  return (
    <div className="space-y-5 max-w-6xl mx-auto">
      <PageHeader
        title="Embed URL Generator"
        description="Generate a standard SSO URL with an embed secret supplied for this request only."
        icon={<Blobby mood="embed" size={58} className="animate-float" style={{ animationDuration: '3.7s' }} />}
      />

      <AdminReadinessPanel
        workspace="developer"
        instanceId={connection.instanceId}
        baseUrl={connection.baseUrl}
      />

      <div className="grid md:grid-cols-3 gap-4 items-stretch">
        <div className="card p-4">
          <div className="text-xs font-medium text-content-secondary uppercase tracking-wider">Governance Use Case</div>
          <div className="mt-2 text-sm font-semibold text-content-primary">URL generation check</div>
          <p className="mt-1 text-xs text-content-secondary leading-5">A generated URL confirms only that Omni accepted this signing request. It does not prove end-user access.</p>
        </div>
        <div className="card p-4">
          <div className="text-xs font-medium text-content-secondary uppercase tracking-wider">Identity Context</div>
          <div className="mt-2 text-sm font-semibold text-content-primary">External ID, email, groups</div>
          <p className="mt-1 text-xs text-content-secondary leading-5">Pass the same identity claims your embedded app will send in production.</p>
        </div>
        <div className="card p-4 border-yellow-200 bg-yellow-50">
          <div className="text-xs font-medium text-yellow-800 uppercase tracking-wider">Sensitive Output</div>
          <div className="mt-2 text-sm font-semibold text-yellow-900">Treat URLs like credentials</div>
          <p className="mt-1 text-xs text-yellow-800 leading-5">Signed embed URLs can grant access. Share only through the approved implementation channel.</p>
        </div>
      </div>

      <div className="max-w-4xl mx-auto space-y-5">
        <div className="card min-h-[220px] flex flex-col justify-center">
          <h3 className="text-sm font-semibold text-content-primary mb-4">Standard SSO preparation</h3>
          <div className="grid gap-4 md:grid-cols-3 text-sm">
            <div className="flex items-start gap-2">
              <div>
                <div className="font-medium text-content-primary">Input required</div>
                <p className="text-xs text-content-secondary mt-0.5 leading-5">Confirm the content path and required external ID and name for this request.</p>
              </div>
            </div>
            <div className="flex items-start gap-2">
              <div>
                <div className="font-medium text-content-primary">Not checked automatically</div>
                <p className="text-xs text-content-secondary mt-0.5 leading-5">OmniKit cannot read standard SSO secret configuration through a documented readiness API.</p>
              </div>
            </div>
            <div className="flex items-start gap-2">
              <div>
                <div className="font-medium text-content-primary">Manual verification required</div>
                <p className="text-xs text-content-secondary mt-0.5 leading-5">Validate the resulting experience and authorization in the intended application context.</p>
              </div>
            </div>
          </div>
        </div>

        <div className="card">
          <h3 className="text-sm font-semibold text-content-primary mb-4">Configuration</h3>

          {error && (
            <div role="alert" className="bg-red-50 border border-red-200 text-red-700 text-xs px-3 py-2 rounded mb-4">{error}</div>
          )}

          <form onSubmit={handleGenerate} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-content-secondary mb-1">Dashboard Picker</label>
              <DashboardSearch
                dashboards={dashboards}
                loading={loadingDashboards}
                lastSyncedAt={dashboardsSyncedAt}
                onRefresh={refreshDashboards}
                onPick={pickDashboard}
                selectedDashboardId={selectedDashboardId}
                disabled={loading || !connection.baseUrl || !connection.apiKey}
              />
            </div>
            <div>
              <label htmlFor="embed-content-path" className="block text-xs font-medium text-content-secondary mb-1">Content Path *</label>
              <input
                id="embed-content-path"
                type="text"
                value={contentPath}
                onChange={(e) => {
                  setContentPath(e.target.value);
                  setSelectedDashboardId('');
                  invalidateGeneratedUrl();
                }}
                disabled={loading}
                className="input-field"
                placeholder="/dashboards/my-dashboard"
              />
            </div>
            <div>
              <label htmlFor="embed-external-id" className="block text-xs font-medium text-content-secondary mb-1">External ID *</label>
              <input
                id="embed-external-id"
                type="text"
                value={externalId}
                onChange={(e) => {
                  setExternalId(e.target.value);
                  invalidateGeneratedUrl();
                }}
                disabled={loading}
                className="input-field"
                placeholder="user-123"
              />
            </div>
            <div>
              <label htmlFor="embed-name" className="block text-xs font-medium text-content-secondary mb-1">Name *</label>
              <input
                id="embed-name"
                type="text"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  invalidateGeneratedUrl();
                }}
                disabled={loading}
                className="input-field"
                placeholder="John Doe"
              />
            </div>
            <div>
              <label htmlFor="embed-secret" className="block text-xs font-medium text-content-secondary mb-1">Embed Secret *</label>
              <input
                id="embed-secret"
                type="password"
                value={embedSecret}
                onChange={(e) => {
                  setEmbedSecret(e.target.value);
                  invalidateGeneratedUrl();
                }}
                disabled={loading}
                className="input-field"
                autoComplete="new-password"
                placeholder="Supplied for this request only"
              />
              <p className="mt-1 text-xs text-content-secondary">The secret is sent only to the local signing request and cleared after every attempt.</p>
            </div>
            <div>
              <label htmlFor="embed-email" className="block text-xs font-medium text-content-secondary mb-1">Email</label>
              <input
                id="embed-email"
                type="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  invalidateGeneratedUrl();
                }}
                disabled={loading}
                className="input-field"
                placeholder="user@example.com"
              />
            </div>
            <div>
              <label htmlFor="embed-groups" className="block text-xs font-medium text-content-secondary mb-1">Groups (comma-separated)</label>
              <input
                id="embed-groups"
                type="text"
                value={groups}
                onChange={(e) => {
                  setGroups(e.target.value);
                  invalidateGeneratedUrl();
                }}
                disabled={loading}
                className="input-field"
                placeholder="group1, group2"
              />
            </div>
            <button
              type="submit"
              aria-busy={loading}
              disabled={loading || !contentPath.trim() || !externalId.trim() || !name.trim() || !embedSecret.trim()}
              className="btn-primary w-full"
            >
              {loading ? (
                <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              ) : (
                <Link2 size={14} />
              )}
              Generate Embed URL
            </button>
          </form>
        </div>

        {result && (
          <div className="card min-h-[220px]">
            <h3 className="text-sm font-semibold text-content-primary mb-1">Generated URL</h3>
            <p className="mb-3 text-xs text-content-secondary">Generation succeeded. End-user access, content authorization, and production readiness are not verified.</p>
            <div className="bg-gray-900 rounded p-3 mb-3">
              <code className="text-green-400 text-xs font-mono break-all leading-relaxed">{result}</code>
            </div>
            <div className="flex gap-2">
              <button onClick={handleCopy} className="btn-secondary text-sm flex-1">
                {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
                {copied ? 'Copied' : 'Copy URL'}
              </button>
              <a
                href={result}
                target="_blank"
                rel="noopener noreferrer"
                className="btn-secondary text-sm flex-1 justify-center"
              >
                <ExternalLink size={14} />
                Open in New Tab
              </a>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
