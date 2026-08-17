import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ArtifactReconciliationPanel } from '../src/components/aiContentStudio/ArtifactReconciliationPanel';
import { MarkdownLite, OutcomePanel } from '../src/components/aiContentStudio/OutcomePanel';
import type { AIContentJobOutcome } from '../src/services/aiContentStudio/types';

function outcome(message: string, artifactState: AIContentJobOutcome['artifactState'] = 'not-returned'): AIContentJobOutcome {
  return {
    jobId: 'fictional-job-id',
    state: 'COMPLETE',
    resultAvailability: 'available',
    message,
    actionSummaries: [],
    conversationId: 'fictional-conversation-id',
    chatUrl: 'https://example.invalid/chat/fictional-conversation-id',
    documentReferences: [],
    artifactState,
    actionReviewIssues: [],
  };
}

test('AI Content Markdown renders safe semantic tables, ordered lists, and inline emphasis', () => {
  const html = renderToStaticMarkup(
    <MarkdownLite value={[
      '### Query manifest',
      '| Query | Component | Result |',
      '| :--- | --- | ---: |',
      '| **Selector query** | `selector` | *ready* |',
      '| Escaped \\| value | <img src=x onerror=alert(1)> | 4 |',
      '',
      '3. Verify the exact result.',
      '4. Continue in Omni Chat.',
    ].join('\n')} />,
  );

  assert.match(html, /<h3/);
  assert.match(html, /data-testid="ai-content-markdown-table-scroll"/);
  assert.match(html, /<table/);
  assert.match(html, /<thead/);
  assert.match(html, /<tbody/);
  assert.match(html, /<th scope="col"/);
  assert.match(html, /<strong/);
  assert.match(html, /<code/);
  assert.match(html, /<em>ready<\/em>/);
  assert.match(html, /Escaped \| value/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /:---/);
  assert.match(html, /<ol[^>]*start="3"/);
});

test('AI Content Markdown bounds generated table rows, columns, and cell length', () => {
  const header = Array.from({ length: 25 }, (_, index) => `Column ${index + 1}`);
  const separator = header.map(() => '---');
  const rows = Array.from({ length: 101 }, (_, rowIndex) => (
    header.map((_, columnIndex) => (
      rowIndex === 0 && columnIndex === 0
        ? 'x'.repeat(2_050)
        : `r${rowIndex + 1}c${columnIndex + 1}`
    ))
  ));
  const html = renderToStaticMarkup(
    <MarkdownLite value={[
      `| ${header.join(' | ')} |`,
      `| ${separator.join(' | ')} |`,
      ...rows.map((row) => `| ${row.join(' | ')} |`),
    ].join('\n')} />,
  );

  assert.equal(html.match(/<th /g)?.length, 24);
  assert.equal(html.match(/<tr/g)?.length, 101);
  assert.doesNotMatch(html, /r101c1/);
  assert.match(html, /Table display bounded to 24 columns, 100 body rows, and 2,000 characters per cell/);
  assert.match(html, /x{100}.*…/s);
});

test('Narrative Report action-review copy stays no-write and scopes the model-snapshot caveat', () => {
  const html = renderToStaticMarkup(
    <OutcomePanel
      outcome={outcome('## Report\nBounded result.\n## Evidence limits\nVerify all values.\n## Follow-ups\nInspect the exact job.')}
      mode="report"
      contentName=""
      unexpectedActions={['ACTION_DROPPED', 'UNRECOGNIZED_ACTION_TYPE: search_model.']}
      baseUrl="https://example.invalid"
      apiKey="fictional-key"
      expectedModelId="fictional-model"
      modelMutationCheck={{
        status: 'unchanged',
        issues: [],
        checkedAt: '2026-08-14T12:00:00.000Z',
      }}
    />,
  );

  assert.match(html, /Inspect this exact report job and its returned action history/);
  assert.doesNotMatch(html, /resulting documents|resulting artifacts/);
  assert.match(html, /does not verify the report values, query results, or returned action history/);
});

test('creation narratives are explicitly unverified and the App checklist starts behind an exact-App gate', () => {
  const creationHtml = renderToStaticMarkup(
    <OutcomePanel
      outcome={outcome('### Status\nThe Agent reported an App build.', 'not-returned')}
      mode="app"
      contentName="Fictional App"
      unexpectedActions={[]}
      baseUrl="https://example.invalid"
      apiKey="fictional-key"
      expectedModelId="fictional-model"
    />,
  );
  const checklistHtml = renderToStaticMarkup(
    <ArtifactReconciliationPanel
      baseUrl="https://example.invalid"
      apiKey="fictional-key"
      mode="app"
      expectedName="Fictional App"
      expectedModelId="fictional-model"
      references={[]}
    />,
  );

  assert.match(creationHtml, /Omni-reported — not independently verified/);
  assert.match(checklistHtml, /I located the exact App/);
  assert.match(checklistHtml, /<fieldset[^>]*disabled=""/);
  assert.match(checklistHtml, /Marks stay only in this browser view/);
  assert.match(checklistHtml, /checks marked in this browser session/);
  assert.doesNotMatch(checklistHtml, /Team|Player|Play, speed|Frame/);
});
