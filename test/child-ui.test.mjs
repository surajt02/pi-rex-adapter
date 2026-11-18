import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareRun, piArgs, readJson } from '../src/core.mjs';
import { registerChild } from '../src/child.mjs';

// The registry a child Pi is given unless a test injects a pruned one; the
// side conversation narrows it to an active set rather than removing tools.
const REGISTRY = ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls', 'web_enable']
  .map(name => ({ name })).concat([{ name: 'hidden-tool', exposure: 'hidden' }]);

async function fixture(t, kind = 'agent', language = 'en', hasUI = true, options = {}) {
  const { allTools, promoteAcceptMs = 500, ...runOptions } = options;
  const root = await mkdtemp(join(tmpdir(), 'rex-child-ui-'));
  await mkdir(join(root, '.pi'));
  await writeFile(join(root, '.pi', 'rex.json'), JSON.stringify({ language }));
  const run = await prepareRun(root, { kind, name: 'Review', task: '\x1b[31mInspect the diff\ncarefully', cwd: root, ...runOptions }, '');
  const events = {}, commands = {}, statuses = [], widgets = [], entries = [], notices = [];
  const toolCalls = [], sent = [], active = new Set(['read', 'grep']), shutdowns = [];
  const ctx = { hasUI, cwd: root, isIdle: () => true,
    sessionManager: { getEntries: () => entries, getBranch: () => entries },
    shutdown: () => shutdowns.push(true),
    ui: { setStatus: (...args) => statuses.push(args), setWidget: (...args) => widgets.push(args),
      notify: (...args) => notices.push(args),
      setTitle() { assert.fail('Pi owns the terminal title'); },
      setHeader() { assert.fail('Do not replace the Pi header'); },
    },
  };
  registerChild({ on: (name, handler) => { events[name] = handler; },
    registerCommand: (name, command) => { commands[name] = command; },
    getAllTools: () => allTools ?? REGISTRY,
    getActiveTools: () => [...active],
    setActiveTools: names => { toolCalls.push(names); active.clear(); for (const name of names) active.add(name); },
    sendUserMessage: (text, sendOptions) => sent.push({ text, options: sendOptions }),
  }, run.dir, { promoteAcceptMs });
  t.after(async () => { events.session_shutdown(); await rm(root, { recursive: true, force: true }); });
  await events.session_start({}, ctx);
  const state = () => statuses.filter(([key]) => key === 'rex-child').at(-1)?.[1];
  const widget = () => {
    const line = widgets.filter(([key, value]) => key === 'rex-assignment' && value).at(-1)[1]({}, {});
    return line.render(100);
  };
  const promoteFile = async () => (await readdir(run.dir)).filter(f => f.startsWith('promote-')).at(-1);
  // The parent answers by rewriting the note; the child then leaves.
  const accept = async ({ status = 'accepted' } = {}) => {
    const file = await promoteFile();
    const note = await readJson(join(run.dir, file));
    await writeFile(join(run.dir, file), JSON.stringify({ ...note, status }));
    for (let i = 0; i < 100 && !shutdowns.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
    return { file, note };
  };
  const answer = (stopReason = 'stop') => {
    entries.push({ type: 'message', message: { role: 'assistant', content: 'Answer', stopReason } });
  };
  return { run, events, commands, ctx, statuses, widgets, notices, state, widget, answer, promoteFile, accept,
    toolCalls, sent, active, shutdowns };
}

test('agent displays one bounded assignment line and reports queued results without claiming delivery', async t => {
  const h = await fixture(t);
  assert.equal(h.state(), 'Agent · Starting');
  const widget = h.widgets.find(([key, value]) => key === 'rex-assignment' && value)[1]({}, {});
  assert.deepEqual(widget.render(0), []);
  assert.equal(widget.render(24).length, 1);
  assert.ok(widget.render(24)[0].length <= 24);
  assert.doesNotMatch(widget.render(100)[0], /\x1b|\n/);
  assert.match(widget.render(100)[0], /Assigned task: Inspect the diff carefully/);
  await h.events.agent_start();
  assert.equal(h.state(), 'Agent · Running');
  const count = h.statuses.length;
  await h.events.agent_start();
  assert.equal(h.statuses.length, count);
  h.answer(); await h.events.agent_settled({ aborted: false }, h.ctx);
  assert.equal(h.state(), 'Agent · Result queued · awaiting parent review');
  assert.equal((await readdir(h.run.dir)).filter(f => f.startsWith('turn-')).length, 1);
  await h.events.session_start({}, h.ctx);
  assert.equal(h.state(), 'Agent · Result queued · awaiting parent review');
  h.events.session_shutdown();
  assert.equal(h.state(), undefined);
  assert.equal(h.widgets.at(-1)[1], undefined);
});

test('BTW return remains optional in English and Chinese; ordinary answers create no return file', async t => {
  for (const language of ['en', 'zh']) {
    const h = await fixture(t, 'btw', language);
    const widget = h.widgets.find(([key, value]) => key === 'rex-assignment' && value)[1]({}, {});
    assert.match(widget.render(100)[0], language === 'en' ? /Side topic:/ : /侧聊主题：/);
    h.answer(); await h.events.agent_settled({ aborted: false }, h.ctx);
    assert.equal(h.state(), language === 'en'
      ? 'BTW · Answer ready · optionally share with /btw-return'
      : 'BTW · 答案已就绪 · 可用 /btw-return 回传');
    assert.equal((await readdir(h.run.dir)).filter(f => /^(turn|return)-/.test(f)).length, 0);
    assert.equal(h.notices.length, 0);
    await h.commands['btw-return'].handler('Share this', h.ctx);
    assert.equal((await readdir(h.run.dir)).filter(f => f.startsWith('return-')).length, 1);
    assert.equal(h.state(), language === 'en'
      ? 'BTW · Conclusion queued · ready to continue' : 'BTW · 结论已排队 · 可继续侧聊');
    await h.events.agent_start();
    assert.equal(h.state(), language === 'en' ? 'BTW · Running' : 'BTW · 运行中');
  }
});

test('failed and interrupted turns remain distinguishable, and headless children add no UI', async t => {
  const h = await fixture(t, 'agent', 'zh');
  h.answer('error'); await h.events.agent_settled({ aborted: false }, h.ctx);
  assert.equal(h.state(), 'Agent · 失败');
  await h.events.agent_settled({ aborted: true }, h.ctx);
  assert.equal(h.state(), 'Agent · 已中断');
  const headless = await fixture(t, 'agent', 'en', false);
  await headless.events.agent_start();
  headless.answer(); await headless.events.agent_settled({ aborted: false }, headless.ctx);
  assert.deepEqual(headless.statuses, []); assert.deepEqual(headless.widgets, []);
});

test('child session names identify their role while agent-only approval remains scoped', () => {
  for (const kind of ['agent', 'btw']) {
    const args = piArgs({ kind, name: 'Review', dir: '/tmp/task' }, '/tmp/extension.mjs');
    assert.equal(args[args.indexOf('--name') + 1], `${kind === 'agent' ? 'Agent' : 'BTW'} · Review`);
    assert.equal(args.includes('--approve'), kind === 'agent');
    assert.equal(args.includes('--print'), false);
  }
});

test('promote refuses an agent and a running turn, then hands the pane to a parent session', async t => {
  const agent = await fixture(t, 'agent');
  await agent.commands.promote.handler('', agent.ctx);
  assert.match(agent.notices.at(-1)[0], /Only a side conversation/);
  assert.equal(agent.shutdowns.length, 0);
  assert.equal((await readdir(agent.run.dir)).filter(f => f.startsWith('promote-')).length, 0);

  const h = await fixture(t, 'btw');
  // A turn is still running: the transcript must not be handed over mid-answer.
  h.ctx.isIdle = () => false;
  await h.commands.promote.handler('fix it', h.ctx);
  assert.match(h.notices.at(-1)[0], /Wait for this answer/);
  assert.equal((await readdir(h.run.dir)).filter(f => f.startsWith('promote-')).length, 0);
  assert.equal(h.shutdowns.length, 0);

  h.ctx.isIdle = () => true;
  await h.commands.promote.handler('fix the path', h.ctx);
  const stored = await readJson(join(h.run.dir, 'run.json'));
  // Nothing is retagged or enabled here: a child Pi cannot become a parent, so it
  // only asks and leaves, and another process continues the transcript.
  assert.equal(stored.kind, 'btw');
  assert.equal(stored.promotedAt, undefined);
  assert.equal(stored.promotedTools, undefined);
  assert.deepEqual(h.toolCalls, [['read', 'grep', 'find', 'ls', 'web_enable']]);
  assert.deepEqual(h.sent, []);
  assert.match(h.notices.at(-1)[0], /Handing this conversation/);
  // The pane stays alive until the main Pi accepts: leaving at once is how a
  // stale parent used to strand a dead pane.
  assert.equal(h.shutdowns.length, 0);
  const noteFile = await h.promoteFile();
  const note = await readJson(join(h.run.dir, noteFile));
  assert.deepEqual({ ...note, requestedAt: undefined },
    { id: h.run.id, name: 'Review', note: 'fix the path', requestedAt: undefined, status: 'requested' });
  await h.accept();
  assert.equal(h.shutdowns.length, 1);
});

test('bare promote hands over with no first message, in every language', async t => {
  for (const language of ['en', 'zh']) {
    const h = await fixture(t, 'btw', language);
    await h.commands.promote.handler('', h.ctx);
    const { note } = await h.accept();
    assert.equal(note.note, '');
    assert.match(h.notices.at(-1)[0], language === 'en' ? /Handing this conversation/ : /交给它自己的会话/);
    assert.equal(h.shutdowns.length, 1);
  }
});

test('a main Pi that never accepts leaves the pane alive and says to reload it', async t => {
  const h = await fixture(t, 'btw', 'en', true, { promoteAcceptMs: 150 });
  await h.commands.promote.handler('', h.ctx);
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(h.shutdowns.length, 0);
  assert.match(h.notices.at(-1)[0], /run \/reload in the main pane/);
  // The stale note is withdrawn, so a later reload cannot open a pane unasked.
  assert.equal(await h.promoteFile(), undefined);
});

test('a renamed session record still displays as a session, and is never narrowed', async t => {
  // Records already retagged by the earlier in-place promotion stay readable.
  const h = await fixture(t, 'session', 'zh', true, { name: 'aside' });
  assert.equal(h.state(), 'Session · 启动中');
  assert.match(h.widget().join('\n'), /会话：Inspect the diff carefully/);
  h.answer(); await h.events.agent_settled({ aborted: false }, h.ctx);
  assert.equal(h.state(), 'Session · 答案已就绪');
  assert.equal((await readdir(h.run.dir)).filter(f => f.startsWith('turn-')).length, 0);
});

test('a side conversation is narrowed by active set, not by removing tools from the registry', async t => {
  const btw = await fixture(t, 'btw');
  // Registering everything and deactivating most of it is what makes /promote
  // possible; a launch flag would have removed the others from the registry.
  assert.deepEqual(btw.toolCalls, [['read', 'grep', 'find', 'ls', 'web_enable']]);
  assert.deepEqual([...btw.active].sort(), ['find', 'grep', 'ls', 'read', 'web_enable']);
  await btw.events.session_start({}, btw.ctx);
  assert.deepEqual(btw.toolCalls.at(-1), ['read', 'grep', 'find', 'ls', 'web_enable']);
  // Registering a tool activates it, and extensions can register theirs after
  // session_start, so every run narrows again before the model sees the tools.
  btw.active.add('web_search');
  await btw.events.before_agent_start({}, btw.ctx);
  assert.deepEqual([...btw.active].sort(), ['find', 'grep', 'ls', 'read', 'web_enable']);
  assert.deepEqual(btw.toolCalls.at(-1), ['read', 'grep', 'find', 'ls', 'web_enable']);

  const agent = await fixture(t, 'agent');
  assert.deepEqual(agent.toolCalls, []);
  const promoted = await fixture(t, 'session');
  assert.deepEqual(promoted.toolCalls, [], 'a reload must not narrow a promoted session again');
  await promoted.events.before_agent_start({}, promoted.ctx);
  assert.deepEqual(promoted.toolCalls, []);
});
