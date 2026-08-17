import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import tailwindConfig from '../tailwind.config.js';
import { AdvancedDisclosure } from '../src/components/ui/AdvancedDisclosure';
import { ComboBox, resolveComboBoxKeyboardAction } from '../src/components/ui/ComboBox';
import { resolveComboBoxOptionAccessibleText } from '../src/components/ui/comboBoxUtils';
import { PassphraseInput } from '../src/components/ui/PassphraseInput';
import { StatusChip } from '../src/components/ui/StatusChip';

function relativeLuminance(hex: string): number {
  const channels = hex.slice(1).match(/.{2}/g)?.map((channel) => Number.parseInt(channel, 16) / 255) || [];
  assert.equal(channels.length, 3, `Expected a six-digit hex color, received ${hex}`);
  const [red, green, blue] = channels.map((channel) => (
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  ));
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(first: string, second: string): number {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  return (Math.max(firstLuminance, secondLuminance) + 0.05)
    / (Math.min(firstLuminance, secondLuminance) + 0.05);
}

test('AdvancedDisclosure keeps ordinary form content mounted while collapsed', () => {
  const html = renderToStaticMarkup(
    <AdvancedDisclosure title="Optional settings">
      <input name="defaultModel" defaultValue="model-1" />
    </AdvancedDisclosure>,
  );

  assert.match(html, /<details/);
  assert.match(html, /<summary/);
  assert.match(html, /name="defaultModel"/);
});

test('AdvancedDisclosure may defer explicitly read-only content', () => {
  const html = renderToStaticMarkup(
    <AdvancedDisclosure title="Audit details" lazyReadOnly>
      <div>Expensive read-only report</div>
    </AdvancedDisclosure>,
  );

  assert.doesNotMatch(html, /Expensive read-only report/);
});

test('ComboBox exposes one named combobox and deterministic keyboard transitions', () => {
  const html = renderToStaticMarkup(
    <ComboBox
      options={[
        { value: 'alpha', label: 'Alpha' },
        { value: 'beta', label: 'Beta' },
      ]}
      value="alpha"
      onChange={() => undefined}
      ariaLabel="Destination model"
      allowFreeText={false}
    />,
  );

  assert.equal(html.match(/role="combobox"/g)?.length, 1);
  assert.match(html, /role="combobox"/);
  assert.match(html, /aria-label="Destination model"/);
  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /tabindex="0"/i);

  assert.deepEqual(resolveComboBoxKeyboardAction('ArrowDown', {
    isOpen: false,
    highlightedIndex: -1,
    optionCount: 2,
    allowFreeText: false,
    hasSearch: false,
  }), { type: 'open', highlightedIndex: 0 });
  assert.deepEqual(resolveComboBoxKeyboardAction('ArrowDown', {
    isOpen: true,
    highlightedIndex: 0,
    optionCount: 2,
    allowFreeText: false,
    hasSearch: false,
  }), { type: 'move', highlightedIndex: 1 });
  assert.deepEqual(resolveComboBoxKeyboardAction('Enter', {
    isOpen: true,
    highlightedIndex: 1,
    optionCount: 2,
    allowFreeText: false,
    hasSearch: false,
  }), { type: 'select', highlightedIndex: 1 });
  assert.deepEqual(resolveComboBoxKeyboardAction('Escape', {
    isOpen: true,
    highlightedIndex: 1,
    optionCount: 2,
    allowFreeText: false,
    hasSearch: false,
  }), { type: 'close' });
  assert.deepEqual(resolveComboBoxKeyboardAction('Enter', {
    isOpen: true,
    highlightedIndex: -1,
    optionCount: 0,
    allowFreeText: true,
    hasSearch: true,
  }), { type: 'commit-free-text' });
});

test('ComboBox stacked options expose complete, distinguishable connection text without changing keyboard selection', () => {
  const sharedPrefix = 'ATX - MotherDuck migration destination';
  const firstOption = {
    value: 'connection-9a55e86d-3da7-4628-a154-3aac13df8356',
    label: `${sharedPrefix} - primary`,
    subtitle: 'motherduck / production_analytics',
    showValue: true,
  };
  const secondOption = {
    ...firstOption,
    value: 'connection-53c00c07-85ed-4c45-94cb-c434e7f37ae7',
    label: `${sharedPrefix} - recovery`,
  };

  assert.equal(
    resolveComboBoxOptionAccessibleText(firstOption, 'stacked'),
    `${firstOption.label} - ${firstOption.subtitle} - ID: ${firstOption.value}`,
  );
  assert.equal(
    resolveComboBoxOptionAccessibleText(secondOption, 'stacked'),
    `${secondOption.label} - ${secondOption.subtitle} - ID: ${secondOption.value}`,
  );
  assert.notEqual(
    resolveComboBoxOptionAccessibleText(firstOption, 'stacked'),
    resolveComboBoxOptionAccessibleText(secondOption, 'stacked'),
  );
  assert.equal(
    resolveComboBoxOptionAccessibleText({ ...firstOption, label: firstOption.value }, 'stacked'),
    `${firstOption.value} - ${firstOption.subtitle}`,
  );

  assert.deepEqual(resolveComboBoxKeyboardAction('Enter', {
    isOpen: true,
    highlightedIndex: 1,
    optionCount: 2,
    allowFreeText: false,
    hasSearch: false,
  }), { type: 'select', highlightedIndex: 1 });
});

test('PassphraseInput supports an explicit visible-label association', () => {
  const html = renderToStaticMarkup(
    <div>
      <label htmlFor="vault-passphrase">Vault passphrase</label>
      <PassphraseInput
        id="vault-passphrase"
        value=""
        onChange={() => undefined}
        placeholder="Enter vault passphrase"
      />
    </div>,
  );

  assert.match(html, /<label for="vault-passphrase">Vault passphrase<\/label>/);
  assert.match(html, /<input id="vault-passphrase"/);
});

test('schedule editor source preserves complete dialog and form-control semantics', () => {
  const source = readFileSync(new URL('../src/pages/SchedulesPage.tsx', import.meta.url), 'utf8');

  assert.match(source, /ref=\{dialogRef\}/);
  assert.match(source, /tabIndex=\{-1\}/);
  assert.match(source, /role="dialog"/);
  assert.match(source, /aria-modal="true"/);
  assert.match(source, /aria-labelledby="schedule-form-title"/);
  assert.match(source, /aria-describedby="schedule-form-description"/);
  assert.match(source, /event\.key === 'Escape'/);
  assert.match(source, /event\.key !== 'Tab'/);
  assert.match(source, /previousFocusRef\.current\?\.focus\(\)/);
  assert.match(source, /role="alert"/);

  for (const id of [
    'schedule-form-name',
    'schedule-form-dashboard-search',
    'schedule-form-cron',
    'schedule-form-timezone',
    'schedule-form-format',
    'schedule-form-destination',
    'schedule-form-recipients',
    'schedule-form-subject',
    'schedule-form-webhook-url',
    'schedule-form-test-now',
  ]) {
    assert.match(source, new RegExp(`htmlFor="${id}"`), id);
    assert.match(source, new RegExp(`id="${id}"`), id);
  }
});

test('disconnected status keeps its evidence copy and uses a visible neutral dot', () => {
  const source = readFileSync(new URL('../src/pages/ConnectPage.tsx', import.meta.url), 'utf8');

  assert.match(source, /dot: '#7A6870', text: 'Awaiting credentials', pulse: false/);
  assert.ok(contrastRatio('#7A6870', '#FFFFFF') >= 3);
});

test('final focus and warning tokens satisfy WCAG non-text and text contrast', () => {
  const colors = tailwindConfig.theme.extend.colors;
  const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
  const focusToken = css.match(/--omni-focus-indicator:\s*(#[0-9a-f]{6})/i)?.[1];
  const warningChip = renderToStaticMarkup(<StatusChip status="warning" />);

  assert.ok(focusToken, 'The final CSS must expose the focus indicator color token.');
  assert.match(warningChip, /bg-warning-light/);
  assert.match(warningChip, /text-warning/);
  assert.equal(focusToken.toUpperCase(), colors.brand.wine.toUpperCase());
  assert.ok(contrastRatio(focusToken, colors.surface.primary) >= 3);
  assert.ok(contrastRatio(focusToken, colors.surface.secondary) >= 3);
  assert.ok(contrastRatio(focusToken, '#FFFFFF') >= 3);
  assert.ok(contrastRatio(colors.warning.DEFAULT, colors.warning.light) >= 4.5);
});

test('Fontsource provenance maps every bundled binary without a runtime dependency', () => {
  const fonts = [
    ['CalSans-Latin-400.woff2', '@fontsource/cal-sans@5.3.0'],
    ['IBMPlexSans-Latin-400.woff2', '@fontsource/ibm-plex-sans@5.3.0'],
    ['IBMPlexSans-Latin-500.woff2', '@fontsource/ibm-plex-sans@5.3.0'],
    ['IBMPlexSans-Latin-600.woff2', '@fontsource/ibm-plex-sans@5.3.0'],
    ['IBMPlexSans-Latin-700.woff2', '@fontsource/ibm-plex-sans@5.3.0'],
    ['IBMPlexMono-Latin-400.woff2', '@fontsource/ibm-plex-mono@5.3.0'],
    ['IBMPlexMono-Latin-500.woff2', '@fontsource/ibm-plex-mono@5.3.0'],
    ['IBMPlexMono-Latin-600.woff2', '@fontsource/ibm-plex-mono@5.3.0'],
    ['IBMPlexMono-Latin-700.woff2', '@fontsource/ibm-plex-mono@5.3.0'],
  ] as const;
  const provenance = readFileSync(new URL('../src/assets/fonts/PROVENANCE.md', import.meta.url), 'utf8');
  const packageManifest = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  const licenses = [
    ['LICENSE-Cal-Sans.txt', '16b9fb909cf491ab6ac2264c332b6b61f63430d6ab639b99ccf36b4ba5f8ca06'],
    ['LICENSE-IBM-Plex.txt', 'd0283623ef57e722fd0eb688a8041589670c608ab780cd3612d06ba6f153d3fd'],
    ['LICENSE-IBM-Plex-Mono.txt', '23b0a9d0c6d3f140a0b77e483c5cfa6bba574325ef5cb189ed9f2fec4884533f'],
  ] as const;

  for (const [fileName, sourcePackage] of fonts) {
    const bytes = readFileSync(new URL(`../src/assets/fonts/${fileName}`, import.meta.url));
    const hash = createHash('sha256').update(bytes).digest('hex');
    assert.ok(provenance.includes(fileName));
    assert.match(provenance, new RegExp(sourcePackage.replace('/', '\\/')));
    assert.match(provenance, new RegExp(hash));
  }

  for (const [fileName, expectedHash] of licenses) {
    const bytes = readFileSync(new URL(`../src/assets/fonts/${fileName}`, import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expectedHash);
    assert.match(provenance, new RegExp(fileName));
    assert.match(provenance, new RegExp(expectedHash));
  }

  assert.doesNotMatch(packageManifest, /"@fontsource\//);
});
