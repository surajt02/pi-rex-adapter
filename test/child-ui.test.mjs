import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareRun, piArgs, readJson } from '../src/core.mjs';
import { registerChild } from '../src/child.mjs';

// Every side conversation records no tool loadout unless a test asks for one;
// promotion then falls back to the core tools, which is covered below.
const REGISTRY = ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls']
  .map(name => ({ name })).concat([{ name: 'hidden-tool', exposure: 'hidden' }]);

async function fixture(t, kind = 'agent', language = 'en', hasUI = true, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'rex-child-ui-'));
  await mkdir(join(root, '.pi'));
  await writeFile(join(root, '.pi', 'rex.json'), JSON.stringify({ language }));
  const run = await prepareRun(root, { kind, name: 'Review', task: '\x1b[31mInspect the diff\ncarefully', cwd: root, ...options }, '');
  const events = {}, commands = {}, statuses = [], widgets = [], entries = [], notices = [];
  const toolCalls = [], sent = [], active = new Set(['read', 'grep']);
  const ctx = { hasUI, cwd: root, isIdle: () => true,
    sessionManager: { getEntries: () => entries, getBranch: () => entries },
    ui: { setStatus: (...args) => statuses.push(args), setWidget: (...args) => widgets.push(args),
      notify: (...args) => notices.push(args),
      setTitle() { assert.fail('Pi owns the terminal title'); },
      setHeader() { assert.fail('Do not replace the Pi header'); },
    },
  };
  registerChild({ on: (name, handler) => { events[name] = handler; },
    registerCommand: (name, command) => { commands[name] = command; },
    getAllTools: () => REGISTRY,
    getActiveTools: () => [...active],
    setActiveTools: names => { toolCalls.push(names); active.clear(); for (const name of names) active.add(name); },
    sendUserMessage: (text, sendOptions) => sent.push({ text, options: sendOptions }),
  }, run.dir);
  t.after(async () => { events.session_shutdown(); await rm(root, { recursive: true, force: true }); });
  await events.session_start({}, ctx);
  const state = () => statuses.filter(([key]) => key === 'rex-child').at(-1)?.[1];
  const widget = () => {
    const line = widgets.filter(([key, value]) => key === 'rex-assignment' && value).at(-1)[1]({}, {});
    return line.render(100);
  };
  const answer = (stopReason = 'stop') => {
    entries.push({ type: 'message', message: { role: 'assistant', content: 'Answer', stopReason } });
  };
  return { run, events, commands, ctx, statuses, widgets, notices, state, widget, answer, toolCalls, sent, active };
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

test('promote refuses an agent, refuses mid-answer, and switches this pane to a session in place', async t => {
  const agent = await fixture(t, 'agent');
  await agent.commands.promote.handler('', agent.ctx);
  assert.match(agent.notices.at(-1)[0], /Only a side conversation/);
  assert.equal(agent.toolCalls.length, 0);

  const h = await fixture(t, 'btw', 'en', true, { promoteTools: ['read', 'bash', 'edit', 'not-registered'] });
  // A turn is still running: nothing may be consumed, because the tool set would
  // change under that turn.
  h.ctx.isIdle = () => false;
  await h.commands.promote.handler('fix it', h.ctx);
  assert.match(h.notices.at(-1)[0], /Wait for this answer/);
  assert.equal((await readJson(join(h.run.dir, 'run.json'))).kind, 'btw');
  assert.equal(h.toolCalls.length, 0); assert.equal(h.sent.length, 0);
  assert.equal((await readdir(h.run.dir)).filter(f => f.startsWith('promote-')).length, 0);

  h.ctx.isIdle = () => true;
  await h.commands.promote.handler('fix the path', h.ctx);
  const stored = await readJson(join(h.run.dir, 'run.json'));
  assert.equal(stored.kind, 'session');
  assert.equal(stored.name, 'Review'); // the topic survives; the pane label does not change here
  assert.ok(stored.promotedAt);
  // The parent's loadout, minus a tool this process does not have and a hidden one.
  assert.deepEqual(stored.promotedTools, ['read', 'bash', 'edit']);
  assert.deepEqual(h.toolCalls.at(-1), ['read', 'bash', 'edit']);
  assert.deepEqual([...h.active].sort(), ['bash', 'edit', 'read']);
  assert.deepEqual((await readdir(h.run.dir)).filter(f => f.startsWith('promote-')).length, 1);
  const [noteFile] = (await readdir(h.run.dir)).filter(f => f.startsWith('promote-'));
  assert.deepEqual(await readJson(join(h.run.dir, noteFile)),
    { id: h.run.id, name: 'Review', tools: ['read', 'bash', 'edit'], requestedAt: stored.promotedAt, status: 'promoted' });
  // A note becomes the first message of the session, unexpanded.
  assert.deepEqual(h.sent, [{ text: 'fix the path', options: { expandPromptTemplates: false } }]);
  assert.match(h.notices.at(-1)[0], /your note was sent/);
  assert.match(h.widget().join('\n'), /Session: Inspect the diff carefully/);
  assert.equal(h.state(), 'Session · Pi idle');
  // Promotion is one-way, and the side-conversation command stops answering.
  await h.commands.promote.handler('again', h.ctx);
  assert.match(h.notices.at(-1)[0], /already a session/);
  assert.equal(h.sent.length, 1);
  await h.commands['btw-return'].handler('share', h.ctx);
  assert.equal((await readdir(h.run.dir)).filter(f => f.startsWith('return-')).length, 0);
});

test('bare promote opens idle, and the promoted session reports its own state', async t => {
  const h = await fixture(t, 'btw', 'zh');
  await h.commands.promote.handler('', h.ctx);
  assert.equal(h.sent.length, 0);
  assert.match(h.notices.at(-1)[0], /全部工具已开启/);
  // The kind prefix stays English in every language, exactly as BTW and Agent do.
  assert.equal(h.state(), 'Session · Pi 待命');
  assert.match(h.widget().join('\n'), /会话：Inspect the diff carefully/);
  h.answer(); await h.events.agent_settled({ aborted: false }, h.ctx);
  assert.equal(h.state(), 'Session · 答案已就绪');
  // A session writes no turn receipts: this is not a delegated agent.
  assert.equal((await readdir(h.run.dir)).filter(f => f.startsWith('turn-')).length, 0);
});

test('promotion without a recorded loadout falls back to the core tools', async t => {
  const h = await fixture(t, 'btw');
  await h.commands.promote.handler('', h.ctx);
  const stored = await readJson(join(h.run.dir, 'run.json'));
  assert.deepEqual(stored.promotedTools, ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls']);
  assert.equal(stored.kind, 'session');
});
