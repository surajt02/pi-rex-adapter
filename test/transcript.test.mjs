import test from 'node:test';
import assert from 'node:assert/strict';
import { actionText, agentBody, agentHeader, agentSnapshot, chainSnapshot, component, flattenReport, fingerprint, isActive, pipelineBody, pipelineHeader, REPORT_LIMIT, COMPACT_WIDTH } from '../src/transcript.mjs';
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

test('an expanded row shows the whole report, not the first six lines', () => {
  const text = Array.from({ length: 9 }, (_, i) => `line ${i}`).join('\n\n');
  const lines = flat(agentBody(agent({ text }), { width: 120, expanded: true }));
  assert.equal(lines.length, 1 + 9, 'one facts line and every report line');
  assert.match(lines[1], /^ {4}line 0$/);
  assert.match(lines.at(-1), /^ {4}line 8$/, 'the ending is reachable');
  assert.doesNotMatch(lines.join('\n'), /more lines/);
  assert.deepEqual(flat(agentBody(agent({ text }), { width: 120 })), ['  ⎿ Done · deepseek-v4.1-flash · 2 turns · 3 tool uses · 5.4k token · 41s'],
    'collapsed rows stay one line');
});

test('markdown flattens: no pipes, no backticks, no heading marks, rules dropped', () => {
  assert.deepEqual(flattenReport([
    '## Exports', '', '| Export | Value |', '|---|---|', '| `TIME_WIDTH` | `7` |', '**Bold** claim',
  ].join('\n')), ['Exports', 'Export · Value', 'TIME_WIDTH · 7', 'Bold claim']);
});

test('an expanded row names what the child actually ran, once, before the report', () => {
  const actions = ['read src/columns.mjs', 'grep export', 'read README.md', 'bash npm test', 'read CHANGELOG.md'];
  const lines = flat(agentBody(agent({ actions, text: 'done' }), { width: 126, expanded: true }));
  assert.equal(lines[1], '    read src/columns.mjs · grep export · read README.md · bash npm test · +1 more');
  assert.equal(lines[2], '    done');
  assert.equal(actionText({ actions: [] }), '');
  const narrow = actionText({ actions }, 40);
  assert.ok(measure(narrow) <= 40, `${measure(narrow)} > 40`);
  assert.match(narrow, /\+\d+ more$/);
  assert.deepEqual(flat(agentBody(agent({ actions, text: 'done' }), { width: 126 })).length, 1,
    'collapsed rows do not spend a line on actions');
});

test('a long report line wraps under the row instead of being clipped', () => {
  const text = 'word '.repeat(60).trim();
  const lines = flat(agentBody(agent({ text }), { width: 80, expanded: true }));
  assert.ok(lines.length > 2, 'the line became several');
  for (const line of lines.slice(1)) {
    assert.match(line, /^ {4}\S/, 'continuations keep the hang indent');
    assert.ok(measure(line) <= 80, `${measure(line)} > 80`);
  }
  assert.equal(lines.slice(1).map(line => line.trim()).join(' '), text, 'no words lost or duplicated');
});

test("a report at the parent's cap says it was cut", () => {
  const lines = flat(agentBody(agent({ text: 'x'.repeat(REPORT_LIMIT) }), { width: 126, expanded: true }));
  assert.match(lines.at(-1), /report truncated at 4000 characters/);
});

test('a chain finishing moves the header even though every agent row is settled', () => {
  const settled = [agent({ state: 'completed' }), agent({ state: 'completed', text: 'two' })];
  assert.notEqual(fingerprint(settled, '1/2'), fingerprint(settled, '2/2'));
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

test('a finished chain still knows its count after its panes closed themselves', () => {
  const record = { id: 'c1', title: 'row render check', status: 'completed', steps: [
    { index: 0, agent: 'scout', label: 'List column helpers', status: 'completed', text: 'one' },
    { index: 1, agent: 'reviewer', label: 'Check formatter boundaries', status: 'completed', text: 'two' },
  ] };
  // What the row last drew while the panes existed: one step done, the other running.
  const previous = { title: 'row render check', done: 1, total: 2, agents: [
    agent({ label: 'List column helpers', state: 'completed', text: 'one' }),
    agent({ label: 'Check formatter boundaries', role: 'reviewer', state: 'running', tokens: 900, text: 'two' }),
  ] };
  const snapshot = chainSnapshot(record, previous);
  assert.equal(snapshot.done, 2, 'the count comes from the record, not the snapshot');
  assert.equal(snapshot.total, 2);
  assert.deepEqual(snapshot.agents.map(a => a.state), ['completed', 'completed']);
  assert.equal(snapshot.agents[1].tokens, 900, 'numbers measured while the pane existed are kept');
  assert.equal(snapshot.agents[1].role, 'reviewer');
  assert.equal(chainSnapshot({ steps: [] }, previous), undefined, 'a record with no steps says nothing');
});
