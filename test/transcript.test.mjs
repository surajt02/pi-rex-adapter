import test from 'node:test';
import assert from 'node:assert/strict';
import { agentBody, agentHeader, agentSnapshot, component, fingerprint, isActive, pipelineBody, pipelineHeader, PREVIEW_LINES, COMPACT_WIDTH } from '../src/transcript.mjs';
import { measure } from '../src/columns.mjs';

const agent = (extra = {}) => ({ label: 'List overview exports', role: 'scout', model: 'deepseek-v4.1-flash',
  state: 'completed', turns: 2, toolUses: 3, tokens: 5400, seconds: 41, ...extra });
const flat = lines => lines.map(line => line.map(([text]) => text).join(''));

test('a single agent is one header row: glyph, goal, role', () => {
  const [line] = flat(agentHeader(agent({ state: 'running' }), { now: 0 }));
  assert.match(line, /^[·✢✳✶✻✽] List overview exports \(scout\)$/);
  const [done] = flat(agentHeader(agent(), { now: 0 }));
  assert.match(done, /^● List overview exports \(scout\)$/);
  const [failed] = flat(agentHeader(agent({ state: 'failed' }), { now: 0 }));
  assert.match(failed, /^● List overview exports/);
});

test('the expand hint is whatever Pi says the key is, and nothing when unavailable', () => {
  const context = { keyHint: (id, what) => `${id === 'app.tools.expand' ? 'ctrl+o' : id} ${what}` };
  const header = flat(agentHeader(agent(), { now: 0, hint: context.keyHint('app.tools.expand', 'to expand') }))[0];
  assert.match(header, /\(ctrl\+o to expand\)$/);
  assert.doesNotMatch(flat(agentHeader(agent(), { now: 0 }))[0], /expand/);
});

test('the facts line leads with state and ends with the clock, when there is a clock', () => {
  const [line] = flat(agentBody(agent(), { width: 120 }));
  assert.equal(line, '  ⎿ Done · deepseek-v4.1-flash · 2 turns · 3 tool uses · 5.4k token · 41s');

  const [running] = flat(agentBody(agent({ state: 'running', seconds: undefined }), { width: 120 }));
  assert.equal(running, '  ⎿ Running · deepseek-v4.1-flash · 2 turns · 3 tool uses · 5.4k token',
    'a running agent has no finished duration to report');
});

test('the model is shown without its provider, which is the parent session\'s own', () => {
  const [line] = flat(agentBody(agent({ model: 'opencode-go/deepseek-v4.1-flash' }), { width: 120 }));
  assert.match(line, /Done · deepseek-v4\.1-flash · 2 turns/);
});

test('a narrow row drops the model before it drops the numbers', () => {
  const narrow = flat(agentBody(agent(), { width: COMPACT_WIDTH - 1 }))[0];
  assert.doesNotMatch(narrow, /deepseek/);
  assert.match(narrow, /2 turns · 3 tool uses · 5\.4k token · 41s/);
  assert.match(flat(agentBody(agent(), { width: COMPACT_WIDTH }))[0], /deepseek/);
});

test('a queued step says it is waiting instead of showing zeros', () => {
  const [line] = flat(agentBody(agent({ state: 'queued', turns: 0, toolUses: 0, tokens: undefined, seconds: undefined }), { width: 120 }));
  assert.equal(line, '  ⎿ Waiting for the previous step');
});

test('a pipeline is a controlled block: header progress, ├ then └, one facts line each', () => {
  const snapshot = { title: 'dot cycle check', done: 1, total: 3, agents: [
    agent({ state: 'completed' }),
    agent({ label: 'Check export usage', state: 'running', seconds: undefined }),
    agent({ label: 'Review plan vs code', role: 'reviewer', state: 'queued' }),
  ] };
  const [header] = flat(pipelineHeader(snapshot, { hint: 'ctrl+o to collapse' }));
  assert.equal(header, '● Pipeline · dot cycle check · 1/3 done (ctrl+o to collapse)');

  const lines = flat(pipelineBody(snapshot, { width: 120 }));
  assert.match(lines[0], /^ {2}├ ● List overview exports \(scout\)$/);
  assert.match(lines[1], /^ {6}⎿ Done · deepseek-v4\.1-flash · 2 turns · 3 tool uses · 5\.4k token · 41s$/);
  assert.match(lines[2], /^ {2}├ [·✢✳✶✻✽] Check export usage \(scout\)$/);
  assert.match(lines[4], /^ {2}└ ○ Review plan vs code \(reviewer\)$/);
  assert.equal(lines[5], '      ⎿ Waiting for the previous step');
  assert.equal(lines.length, 6);
});

test('an expanded row shows the report, capped, and says how much it hid', () => {
  const text = Array.from({ length: PREVIEW_LINES + 2 }, (_, i) => `line ${i}`).join('\n\n');
  const lines = flat(agentBody(agent({ text }), { width: 80, expanded: true }));
  assert.equal(lines.length, 1 + PREVIEW_LINES + 1);
  assert.match(lines[1], /^ {4}line 0$/);
  assert.match(lines.at(-1), /^ {4}… 2 more lines$/);
  assert.deepEqual(flat(agentBody(agent({ text }), { width: 120 })), ['  ⎿ Done · deepseek-v4.1-flash · 2 turns · 3 tool uses · 5.4k token · 41s'],
    'collapsed rows stay one line');
});

test('every rendered line fits the width it was given, colour or not', () => {
  const snapshot = { title: 'a pipeline whose title is long enough to matter at narrow widths', done: 1, total: 3, agents: [
    agent({ state: 'running', seconds: undefined, text: 'x'.repeat(400) }),
    agent({ label: 'A label long enough that a narrow pane has to cut it somewhere', state: 'queued' }),
  ] };
  const paint = (token, text) => `\x1b[38;5;${token === 'error' ? '167m' : '35m'}${text}\x1b[0m`;
  for (const width of [124, 80, 62, 40]) {
    const view = component(w => [...pipelineHeader(snapshot, { hint: 'ctrl+o to collapse' }), ...pipelineBody(snapshot, { width: w, expanded: true })], paint);
    for (const line of view.render(width)) {
      assert.ok(measure(line) <= width, `${measure(line)} > ${width}: ${line}`);
      assert.match(line, /\x1b\[0m$|^$/, 'each line ends with its own reset');
    }
  }
});

test('a header without a known step count claims no progress', () => {
  const [line] = flat(pipelineHeader({ title: 'dot cycle check' }));
  assert.equal(line, '● Pipeline · dot cycle check');
});

test('an unknown call after /reload still renders a truthful row', () => {
  const view = component(() => agentHeader(agentSnapshot({ label: 'Review plan vs code', role: 'reviewer', state: 'launching' }), { now: 0 }));
  assert.match(view.render(80)[0], /Review plan vs code \(reviewer\)/);
});

test('the fingerprint moves when anything worth repainting moves', () => {
  const base = fingerprint([agentSnapshot(agent())]);
  assert.equal(fingerprint([agentSnapshot(agent())]), base);
  assert.notEqual(fingerprint([agentSnapshot(agent({ tokens: 5500 }))]), base);
  assert.notEqual(fingerprint([agentSnapshot(agent({ state: 'failed' }))]), base);
  assert.notEqual(fingerprint([agentSnapshot(agent({ seconds: 42 }))]), base);
  assert.equal(isActive('running'), true);
  assert.equal(isActive('completed'), false);
});
