// The dashboard is one static file with inline CSS and JS, so nothing type checks it. These
// checks catch the kind of mistake that only shows up as a dead button on a phone: a JS syntax
// error, a reference to an element id that no longer exists, an action with no handler, a
// theme that is only half wired up, an emoji sneaking back into the UI.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(here, '..', 'public', 'index.html');
const html = fs.readFileSync(file, 'utf-8');

function scriptBlocks() {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
}

function script() {
  return scriptBlocks().join('\n');
}

test('every dashboard script parses', () => {
  const blocks = scriptBlocks();
  assert.ok(blocks.length > 0, 'index.html should contain inline scripts');
  for (const [index, block] of blocks.entries()) {
    assert.doesNotThrow(() => new Function(block), `script block ${index} does not parse`);
  }
});

test('the dashboard stylesheet is balanced', () => {
  const css = html.match(/<style>([\s\S]*?)<\/style>/);
  assert.ok(css, 'index.html should contain an inline stylesheet');
  const open = (css[1].match(/\{/g) || []).length;
  const close = (css[1].match(/\}/g) || []).length;
  assert.equal(open, close, 'unbalanced braces in the inline CSS');
});

test('every element id the script looks up exists in the markup', () => {
  const js = script();
  const used = new Set([
    ...[...js.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)].map((match) => match[1]),
    ...[...js.matchAll(/getElementById\('([A-Za-z0-9_-]+)'\)/g)].map((match) => match[1])
  ]);
  const declared = new Set([...html.matchAll(/\bid="([A-Za-z0-9_-]+)"/g)].map((match) => match[1]));
  const missing = [...used].filter((id) => !declared.has(id));
  assert.deepEqual(missing, [], `ids used by the script but missing in the markup: ${missing.join(', ')}`);
});

test('every inline handler calls a function that exists', () => {
  const js = script();
  const called = new Set(
    [...html.matchAll(/on(?:click|input|submit|change)="([A-Za-z_$][\w$]*)\(/g)].map((match) => match[1])
  );
  const declared = new Set([...js.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)].map((match) => match[1]));
  const missing = [...called].filter((name) => !declared.has(name));
  assert.deepEqual(missing, [], `inline handlers calling missing functions: ${missing.join(', ')}`);
});

test('every rendered action has a handler', () => {
  const js = script();
  const rendered = new Set([...js.matchAll(/data-act="([a-z]+)"/g)].map((match) => match[1]));
  const handled = new Set([...js.matchAll(/act === '([a-z]+)'/g)].map((match) => match[1]));
  const dead = [...rendered].filter((act) => !handled.has(act));
  assert.deepEqual(dead, [], `actions rendered without a handler: ${dead.join(', ')}`);
  assert.ok(rendered.size >= 6, `expected the usual server actions to be rendered, saw ${rendered.size}`);
});

test('the add/edit form exposes both server switches', () => {
  const js = script();
  assert.match(html, /id="formEnabled"/, 'the form should have an enabled switch');
  assert.match(html, /id="formAutoStart"/, 'the form should have an autostart switch');
  assert.match(js, /enabled: \$\('formEnabled'\)\.checked/, 'the payload should carry enabled');
  assert.match(js, /autoStart: \$\('formAutoStart'\)\.checked/, 'the payload should carry autoStart');
});

test('both themes are defined and the toggle is wired', () => {
  assert.match(html, /<html lang="zh-CN" data-theme="dark">/, 'dark should be the default theme');
  assert.match(html, /:root\[data-theme="light"\]\s*\{/, 'a light theme token block is required');
  assert.match(html, /id="themeToggle"/, 'the header needs a theme toggle');
  assert.match(script(), /setTheme\(/, 'the theme toggle should call setTheme');
  assert.match(script(), /localStorage/, 'the chosen theme should survive a reload');
  assert.match(script(), /prefers-color-scheme/, 'the theme should follow the system by default');
});

test('the UI chrome uses no emoji', () => {
  // Icons are inline SVG symbols; emoji as interface chrome are exactly what this rewrite
  // dropped, so keep them out of the markup and the script.
  const emoji = /[\u231A-\u231B\u23E9-\u23FA\u25A0-\u25FF\u2600-\u27BF\u2B00-\u2BFF\u{1F000}-\u{1FAFF}\uFE0F]/u;
  const offender = html.match(emoji);
  assert.equal(offender, null, `emoji found in the dashboard: ${offender && offender[0]}`);
});
