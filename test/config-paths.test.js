// The hub accepts `~` and `$HOME` in the paths it hands to child processes, so one
// servers.json can move between a phone and a laptop. These entries stay disabled: the test
// only checks how the config is normalised, not whether anything can be spawned.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-config-paths-'));
const configPath = path.join(workDir, 'servers.json');
const home = os.homedir();

const disabled = { transport: 'stdio', enabled: false, autoStart: false };

fs.writeFileSync(configPath, JSON.stringify([
  {
    id: 'tilde',
    name: 'Tilde',
    command: '~/bin/tool',
    args: ['--config', '${HOME}/etc/tool.json', '$HOME/var', 'plain'],
    cwd: '~/projects',
    env: { KEBIAO_DIR: '~/kebiao', MEMORY_FILE_PATH: '$HOME/memory.jsonl', PLAIN: 'value' },
    ...disabled
  },
  { id: 'bare', name: 'Bare', command: '~', cwd: '~', env: {}, ...disabled },
  {
    id: 'absolute',
    name: 'Absolute',
    command: '/usr/bin/node',
    args: ['/etc/app.conf'],
    cwd: '/srv/app',
    env: { PATH: '/usr/bin:/bin' },
    ...disabled
  }
], null, 2));

process.env.MCP_HUB_CONFIG = configPath;
process.env.MCP_HUB_PORT = '0';
process.env.MCP_HUB_HOST = '127.0.0.1';
delete process.env.MCP_HUB_TOKEN;

const { startHub } = await import('../index.js');
const hub = await startHub({ port: 0, host: '127.0.0.1', banner: false, signals: false });

test.after(async () => {
  await hub.close();
  fs.rmSync(workDir, { recursive: true, force: true });
});

async function servers() {
  const res = await fetch(`${hub.url}/api/servers`);
  assert.equal(res.status, 200);
  return (await res.json()).servers;
}

const byId = (list, id) => list.find((entry) => entry.id === id);

test('config paths expand ~, $HOME and ${HOME}', async () => {
  const tilde = byId(await servers(), 'tilde');
  assert.equal(tilde.command, path.join(home, 'bin/tool'));
  assert.equal(tilde.cwd, path.join(home, 'projects'));
  assert.deepEqual(tilde.args, [
    '--config', path.join(home, 'etc/tool.json'), path.join(home, 'var'), 'plain'
  ]);
  assert.equal(tilde.env.KEBIAO_DIR, path.join(home, 'kebiao'));
  assert.equal(tilde.env.MEMORY_FILE_PATH, path.join(home, 'memory.jsonl'));
  assert.equal(tilde.env.PLAIN, 'value');
});

test('a bare ~ expands on its own', async () => {
  const bare = byId(await servers(), 'bare');
  assert.equal(bare.command, home);
  assert.equal(bare.cwd, home);
});

test('absolute paths and ordinary values are left alone', async () => {
  const absolute = byId(await servers(), 'absolute');
  assert.equal(absolute.command, '/usr/bin/node');
  assert.equal(absolute.cwd, '/srv/app');
  assert.deepEqual(absolute.args, ['/etc/app.conf']);
  assert.equal(absolute.env.PATH, '/usr/bin:/bin');
});
