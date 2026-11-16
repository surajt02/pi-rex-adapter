import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseFrontmatter, toRole, discoverRoles, findRole, applyRole, roleSummary } from '../src/roles.mjs';
import { prepareRun, piArgs } from '../src/core.mjs';

async function temp(t) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-rex-roles-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function role(dir, name, text) {
  await mkdir(join(dir, 'agents'), { recursive: true });
  await writeFile(join(dir, 'agents', `${name}.md`), text);
}

const scouting = `---
description: "Map a codebase"
model: opencode-go/deepseek-v4.1-flash
thinking: low
tools: bash, read, grep, find, ls
deny-tools: edit,write
skills: analyze-sessions
fork: false
session-mode: standalone
---
You are read-only. Report file paths and line numbers.
`;

test('frontmatter accepts quoting and ignores other harnesses keys', () => {
  const { fields, body } = parseFrontmatter(scouting);
  assert.equal(fields.description, 'Map a codebase');
  assert.equal(fields.fork, 'false');
  assert.equal(body, 'You are read-only. Report file paths and line numbers.');
});

test('a role without frontmatter is all body', () => {
  const { fields, body } = parseFrontmatter('Just instructions.\n');
  assert.deepEqual(fields, {});
  assert.equal(body, 'Just instructions.');
});

test('toRole maps the fields the adapter honours and drops the rest', () => {
  const mapped = toRole('scout', scouting);
  assert.equal(mapped.name, 'scout');
  assert.equal(mapped.model, 'opencode-go/deepseek-v4.1-flash');
  assert.equal(mapped.thinking, 'low');
  assert.deepEqual(mapped.tools, ['bash', 'read', 'grep', 'find', 'ls']);
  assert.deepEqual(mapped.denyTools, ['edit', 'write']);
  assert.deepEqual(mapped.skills, ['analyze-sessions']);
  assert.equal(mapped.fork, false);
  assert.equal(mapped.systemPrompt, 'You are read-only. Report file paths and line numbers.');
  assert.equal(mapped.sessionMode, undefined);
});

test('project roles override user roles and filenames still resolve', async t => {
  const user = await temp(t), project = await temp(t);
  await role(user, 'scout', '---\ndescription: user scout\n---\nuser body\n');
  await role(user, 'worker', '---\ndescription: user worker\n---\nworker body\n');
  await role(join(project, '.pi'), 'scout', '---\ndescription: project scout\n---\nproject body\n');

  const roles = discoverRoles(project, user);
  assert.deepEqual([...roles.keys()].sort(), ['scout', 'worker']);
  assert.equal(roles.get('scout').description, 'project scout');
  assert.equal(roles.get('scout').systemPrompt, 'project body');
  assert.equal(findRole(roles, 'worker').description, 'user worker');
});

test('a role may be named differently from its file, and either name works', async t => {
  const user = await temp(t);
  await role(user, 'reviewer', '---\nname: critic\ndescription: reviews diffs\n---\nbody\n');
  const roles = discoverRoles(await temp(t), user);
  assert.equal(findRole(roles, 'critic').description, 'reviews diffs');
  assert.equal(findRole(roles, 'reviewer').description, 'reviews diffs');
  assert.equal(findRole(roles, 'nobody'), undefined);
});

test('explicit model beats the role, the role beats the parent', () => {
  const options = { model: 'parent/model', thinking: 'high', cwd: '/tmp' };
  const scout = toRole('scout', scouting);

  assert.equal(applyRole(scout, options, {}).model, 'opencode-go/deepseek-v4.1-flash');
  assert.equal(applyRole(scout, options, { model: 'opencode-go/gemini-4-argon' }).model, 'opencode-go/gemini-4-argon');
  assert.equal(applyRole(scout, options, {}).thinking, 'low');
  assert.equal(applyRole(scout, options, {}).tools, 'bash,read,grep,find,ls');
  assert.equal(applyRole(scout, options, {}).denyTools, 'edit,write');
  assert.equal(applyRole(undefined, options, {}).model, 'parent/model');
  assert.equal(applyRole(undefined, options, {}).role, undefined);
});

test('a role without a model inherits the parent model', () => {
  const role = toRole('plain', '---\ndescription: no pins\n---\nbody\n');
  const applied = applyRole(role, { model: 'parent/model', thinking: 'high' });
  assert.equal(applied.model, 'parent/model');
  assert.equal(applied.thinking, 'high');
  assert.equal(applied.tools, undefined);
  assert.equal(applied.agentPrompt, 'body');
});

test('piArgs carries the role flags and keeps the task as a file reference', async t => {
  const dir = await temp(t);
  const run = { kind: 'agent', name: 'scout', dir, task: 'go', model: 'm', thinking: 'low',
    tools: 'bash,read', denyTools: 'edit', skills: ['analyze-sessions'], agentPrompt: 'body' };
  const args = piArgs(run, '/ext/index.mjs');
  assert.deepEqual(args.slice(0, 8), ['--session', join(dir, 'session.jsonl'), '--name', 'Agent · scout', '-e', '/ext/index.mjs', '--approve', '--model']);
  assert.ok(args.includes('--thinking') && args.includes('low'));
  assert.equal(args[args.indexOf('--tools') + 1], 'bash,read');
  assert.equal(args[args.indexOf('--exclude-tools') + 1], 'edit');
  assert.equal(args[args.indexOf('--skill') + 1], 'analyze-sessions');
  assert.equal(args[args.indexOf('--append-system-prompt') + 1], join(dir, 'agent.md'));
  assert.equal(args.at(-1), `@${join(dir, 'prompt.md')}`);
});

test('prepareRun writes the role instructions privately beside the task', async t => {
  const root = await temp(t);
  const run = await prepareRun(root, { kind: 'agent', name: 'scout', task: 'map it', agentPrompt: 'You are read-only.' }, '');
  const agentFile = join(run.dir, 'agent.md');
  assert.equal((await stat(agentFile)).mode & 0o777, 0o600);
  assert.match(await (await import('node:fs/promises')).readFile(agentFile, 'utf8'), /You are read-only\./);
  assert.match(await (await import('node:fs/promises')).readFile(join(run.dir, 'prompt.md'), 'utf8'), /Current task:\nmapped|map it/);
});

test('a shell run writes no role file', async t => {
  const root = await temp(t);
  const run = await prepareRun(root, { kind: 'shell', name: 'job', task: 'true' }, '');
  await assert.rejects(stat(join(run.dir, 'agent.md')), { code: 'ENOENT' });
});

test('roleSummary lists the discovered roles for the tool description', () => {
  assert.equal(roleSummary(new Map([
    ['scout', { name: 'scout', description: 'Map a codebase' }],
    ['worker', { name: 'worker' }],
  ])), 'scout (Map a codebase), worker');
});
