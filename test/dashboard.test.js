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

// The markup without the inline scripts: Vue templates live there, and that is where a handler
// rename shows up as a dead button.
function markup() {
  return html.replace(/<script>[\s\S]*?<\/script>/g, '');
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
  const bound = new Set(
    [...markup().matchAll(/@(?:click|submit)="([A-Za-z_$][\w$]*)\s*(?:\(|")/g)].map((match) => match[1])
  );
  const exposed = new Set(
    [...js.matchAll(/return \{([\s\S]*?)\};/g)].flatMap((match) =>
      [...match[1].matchAll(/[A-Za-z_$][\w$]*/g)].map((name) => name[0])
    )
  );
  const dead = [...bound].filter((name) => !exposed.has(name));
  assert.deepEqual(dead, [], `actions rendered without a handler: ${dead.join(', ')}`);
  for (const action of ['startServer', 'stopServer', 'restartServer', 'deleteServer', 'openLogs', 'openDetails', 'editServer']) {
    assert.ok(bound.has(action), `the usual server actions should be rendered, ${action} is missing`);
  }
});

test('the add/edit form exposes both server switches', () => {
  const js = script();
  assert.match(markup(), /v-model="form\.enabled"/, 'the form should have an enabled switch');
  assert.match(markup(), /v-model="form\.autoStart"/, 'the form should have an autostart switch');
  assert.match(markup(), /form\.enabled \?/, 'the enabled switch should render its state');
  assert.match(markup(), /form\.autoStart \?/, 'the autostart switch should render its state');
  assert.match(js, /enabled: true, autoStart: true/, 'both switches should default to on');
  assert.match(js, /enabled: form\.value\.enabled, autoStart: form\.value\.autoStart/, 'the payload should carry both switches');
});

test('both themes are defined and the toggle is wired', () => {
  const js = script();
  assert.match(html, /<html lang="zh-CN" class="dark">/, 'dark should be the default theme');
  assert.match(html, /darkMode: 'class'/, 'tailwind should switch themes on the root class');
  assert.match(html, /\.light body\s*\{/, 'a light theme token block is required');
  assert.match(markup(), /@click="toggleTheme"/, 'the header needs a theme toggle');
  assert.match(js, /document\.documentElement\.className = dark \? 'dark' : 'light'/, 'the toggle should swap the root class');
  assert.match(js, /localStorage/, 'the chosen theme should survive a reload');
  assert.match(js, /prefers-color-scheme/, 'the theme should follow the system by default');
});

test('the dashboard is served entirely by the hub', () => {
  // The phone is often offline, so every asset the page pulls in has to live in public/vendor.
  const external = [...html.matchAll(/(?:src|href)="(?:https?:)?\/\/([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(external, [], `external assets are not allowed: ${external.join(', ')}`);

  const vendored = [...html.matchAll(/(?:src|href)="\/vendor\/([^"]+)"/g)].map((match) => match[1]);
  assert.ok(vendored.length >= 3, `the dashboard should use the vendored assets, saw ${vendored.length}`);
  for (const name of vendored) {
    const file = path.join(here, '..', 'public', 'vendor', name);
    assert.ok(fs.existsSync(file), `/vendor/${name} is referenced but public/vendor/${name} is missing`);
    assert.ok(fs.statSync(file).size > 1024, `public/vendor/${name} looks like a placeholder`);
  }
});

test('the UI chrome uses no emoji', () => {
  // Icons are inline SVG symbols; emoji as interface chrome are exactly what this rewrite
  // dropped, so keep them out of the markup and the script.
  const emoji = /[\u231A-\u231B\u23E9-\u23FA\u25A0-\u25FF\u2600-\u27BF\u2B00-\u2BFF\u{1F000}-\u{1FAFF}\uFE0F]/u;
  const offender = html.match(emoji);
  assert.equal(offender, null, `emoji found in the dashboard: ${offender && offender[0]}`);
});
