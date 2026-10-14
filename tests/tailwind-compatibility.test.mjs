import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';

const sourcePath = fileURLToPath(new URL('../src/index.css', import.meta.url));
const source = readFileSync(sourcePath, 'utf8');
const compiled = await postcss([tailwind({ optimize: false })]).process(source, { from: sourcePath });

function rules(selector) {
  const matches = [];
  compiled.root.walkRules(selector, (rule) => matches.push(rule));
  assert.ok(matches.length, `Missing generated selector: ${selector}`);
  return matches;
}

function declaration(selector, property, value) {
  assert.ok(rules(selector).some((rule) => rule.nodes.some((node) => (
    node.type === 'decl' && node.prop === property && node.value === value
  ))), `${selector} must retain ${property}: ${value}`);
}

test('Tailwind v4 retains the Omni theme and explicit application-only source scope', () => {
  assert.match(source, /^@import "tailwindcss" source\(none\);/);
  assert.match(source, /@config "\.\.\/tailwind\.config\.js"/);
  declaration('.bg-surface-primary', 'background-color', '#FCFCF7');
  declaration('.text-content-primary', 'color', '#220411');
  declaration('.rounded-card', 'border-radius', '8px');
  declaration('.border-border', 'border-color', '#DED4CE');
  declaration('.btn-primary', 'background', 'var(--omni-brand-pink)');
  declaration('.input-field', 'border-color', 'var(--omni-border)');
  assert.equal(compiled.warnings().length, 0);
});

test('replacement utilities, responsive layout, and accessibility variants compile', () => {
  declaration('.shrink-0', 'flex-shrink', '0');
  declaration('.shadow-xs', '--tw-shadow', '0 1px 2px 0 var(--tw-shadow-color, rgb(0 0 0 / 0.05))');
  rules('.backdrop-blur-xs');
  const focusOutline = rules('.outline-hidden').map(String).join('\n');
  assert.match(focusOutline, /forced-colors: active/);
  assert.match(focusOutline, /outline: 2px solid transparent/);
  declaration('.md\\:grid-cols-2', 'grid-template-columns', 'repeat(2, minmax(0, 1fr))');
  rules('.motion-safe\\:animate-float');
  rules('.motion-reduce\\:animate-none');
  declaration('button:not(:disabled),\n  [role="button"]:not(:disabled)', 'cursor', 'pointer');
});
