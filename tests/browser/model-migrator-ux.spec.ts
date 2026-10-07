import { expect, test, type Page } from '@playwright/test';
import type { TopicMigrationPlan } from '../../shared/topicMigration';

// Synthetic route fixtures only. No credentials, live models, or warehouse writes.
async function setup(page: Page, options: { restored?: boolean; blocked?: boolean } = {}) {
  const instances = ['source', 'target'].map(id => ({ id, label: `Example ${id}`, role: 'both', baseUrl: `https://${id}.invalid`, apiKeyMasked: 'fixture', metricFilter: { connectionDatabaseContains: [], connectionDatabaseExact: [], embedExternalIdContains: [], embedExternalIdExact: [] }, postMigrationActions: [], createdAt: '', updatedAt: '' }));
  const plan: TopicMigrationPlan = { version: 2, executionProfile: 'branch_preparation_v1', id: 'fixture-plan', revision: 'fixture-review', status: options.blocked ? 'blocked' : 'ready', createdAt: Date.now(), expiresAt: Date.now() + 900_000,
    request: { sourceInstanceId: 'source', sourceConnectionId: 'source-connection', sourceModelId: 'source-model', targetInstanceId: 'target', targetConnectionId: 'target-connection', targetModelId: 'target-model', topicIds: ['orders.topic'], schemaMapText: '' },
    topics: [{ id: 'orders.topic', fileName: 'orders.topic', name: 'Example Orders' }], dependencies: [{ fileName: 'orders.topic', kind: 'topic', topicIds: ['orders.topic'], reasons: ['Selected topic'] }], sourceHash: 'source', targetHash: 'target',
    files: [{ fileName: 'orders.topic', sourceFileName: 'orders.topic', kind: 'topic', topicIds: ['orders.topic'], before: null, proposed: 'base_view: orders', status: options.blocked ? 'blocked' : 'create' }],
    issues: [{ id: 'follow-up', kind: options.blocked ? 'conflict' : 'sql', severity: options.blocked ? 'blocker' : 'review', title: options.blocked ? 'Existing definition conflict' : 'Review SQL', message: 'Review in Omni.', nextAction: 'Review in Omni.', topicIds: ['orders.topic'], fileName: 'orders.topic' }],
  };
  await page.addInitScript(({ restored }) => {
    sessionStorage.setItem('omnikit:activeConnection:v1', JSON.stringify({ baseUrl: 'https://source.invalid', apiKey: '__omnikit_vault_instance__:source', status: 'success', connectionMode: 'vault', instanceId: 'source', instanceLabel: 'Example source', apiKeyMasked: 'fixture' }));
    if (restored) localStorage.setItem('omnikit:topicMigrationDraft:v1', JSON.stringify({ version: 1, planId: 'fixture-plan', approved: true }));
  }, options);
  const writes: string[] = [];
  await page.route('**/api/**', async route => {
    const req = route.request(); const url = new URL(req.url());
    let body: unknown = {};
    if (url.pathname === '/api/vault/status') body = { unlocked: true, exists: true, path: '[fixture]', instanceCount: 2, idleTimeoutMs: 1_800_000, lastActivityAt: Date.now() };
    else if (url.pathname === '/api/instances') body = { instances };
    else if (/\/connections$/.test(url.pathname)) {
      const id = url.pathname.includes('/source/') ? 'source' : 'target';
      body = { connections: [{ id: `${id}-connection`, name: `Example ${id} connection`, dialect: id === 'source' ? 'snowflake' : 'databricks', database: 'EXAMPLE' }] };
    } else if (/\/models$/.test(url.pathname)) {
      const id = url.pathname.includes('/source/') ? 'source' : 'target';
      body = { models: [{ id: `${id}-model`, name: `Example ${id} model`, connectionId: `${id}-connection`, kind: 'SHARED' }] };
    } else if (url.pathname === '/api/model-migrator/topics') body = { topics: plan.topics, sourceHash: plan.sourceHash };
    else if (url.pathname === '/api/model-migrator/topic-plan' || url.pathname === '/api/model-migrator/topic-plan/fixture-plan') body = { plan };
    else if (url.pathname.includes('/stage') || url.pathname.includes('/merge') || url.pathname === '/api/model-migrator/jobs') writes.push(url.pathname);
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto('/models/migrate');
  const close = page.getByRole('button', { name: 'Close walkthrough' });
  if (await close.isVisible().catch(() => false)) await close.click();
  await expect(page.getByRole('heading', { name: 'Model Migrator', exact: true })).toBeVisible();
  return writes;
}

test('one branch workflow requires an explicit destination and has no advanced/publish controls', async ({ page }) => {
  const writes = await setup(page);
  await expect(page.getByRole('combobox', { name: 'Destination instance' })).toContainText('Choose destination instance');
  await expect(page.getByRole('button', { name: 'Choose topics', exact: true })).toBeDisabled();
  await expect(page.getByRole('link', { name: /Advanced whole-model/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Publish/ })).toHaveCount(0);
  expect(writes).toEqual([]);
});

test('restored choices require recheck; SQL follow-ups do not prevent branch approval', async ({ page }) => {
  const writes = await setup(page, { restored: true });
  await expect(page.getByText('Saved choices restored, not approval.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue to branch preparation' })).toBeDisabled();
  await page.getByRole('button', { name: 'Recheck differences' }).click();
  await expect(page.getByRole('button', { name: 'Continue to branch preparation' })).toBeEnabled();
  await page.getByRole('button', { name: 'Continue to branch preparation' }).click();
  await expect(page.getByRole('button', { name: 'Create review branch' })).toBeDisabled();
  await page.getByRole('checkbox', { name: /I reviewed these exact additions/ }).check();
  await expect(page.getByRole('button', { name: 'Create review branch' })).toBeEnabled();
  expect(writes).toEqual([]); // This UI regression deliberately never submits a write.
});

test('unsafe definition conflicts still block branch preparation after recheck', async ({ page }) => {
  await setup(page, { restored: true, blocked: true });
  await page.getByRole('button', { name: 'Recheck differences' }).click();
  await expect(page.getByRole('button', { name: 'Continue to branch preparation' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Hold affected topics and review remaining scope' })).toBeVisible();
});
