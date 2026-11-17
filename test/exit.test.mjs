import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// A script that starts the extension used to hang forever: the recursive watch on
// the task root was never unreferenced, so `node script.mjs` never returned. That
// is what stranded a live pipeline step inside a `node probe.mjs` bash call.
test('a script that launches a task can still exit on its own', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rex-exit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const entry = new URL('../src/index.mjs', import.meta.url).href;
  const script = join(dir, 'launch-and-exit.mjs');
  await writeFile(script, `
import adapter from ${JSON.stringify(entry)};
let blocks = 0;
const rex = {
  async open(run) { return \`block-\${++blocks}\`; },
  async inspect() { return { window: 'window-1' }; },
  async control() { return {}; },
  async reveal() { return true; },
  events() { return () => {}; },
};
const events = {}, tools = [], entries = [];
const ctx = { cwd: ${JSON.stringify(dir)}, hasUI: false, isIdle: () => false,
  sessionManager: {
    getSessionDir: () => ${JSON.stringify(dir)}, getSessionId: () => 'parent',
    getEntries: () => entries, getBranch: () => entries,
  },
  ui: { setWidget() {}, setStatus() {}, notify() {} } };
const pi = { on: (name, fn) => { events[name] = fn; }, registerTool: tool => { tools[tool.name] = tool; },
  registerCommand() {}, getThinkingLevel: () => 'off', appendEntry() {}, sendMessage() {} };
adapter(pi, { rex });
await events.session_start({}, ctx);
await tools.subagent.execute('call', { task: 'bounded task' }, undefined, undefined, ctx);
console.log('launched');
// No session_shutdown: the process must be able to exit on its own.
`);
  const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
  const [code, signal] = await once(child, 'exit');
  clearTimeout(timer);
  assert.match(output, /launched/);
  assert.equal(signal, null, 'the script should not need to be killed');
  assert.equal(code, 0);
});
