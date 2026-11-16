import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Roles are markdown files with an optional frontmatter block:
//
//   ---
//   description: what this role is for
//   model: opencode-go/deepseek-v4.1-flash
//   thinking: high
//   tools: bash,read,grep,find,ls
//   deny-tools: edit,write
//   skills: analyze-sessions
//   cwd: .
//   fork: false
//   ---
//   Role instructions appended to the child's system prompt.
//
// Only fields the adapter can actually honour are read. `session-mode`,
// `auto-exit`, `interactive`, `spawning` and similar keys from other harnesses
// are ignored: a Rex child is always a standalone interactive Pi session.

export function agentDirectory(env = process.env) {
  return env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent');
}

export function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(text);
  if (!match) return { fields: {}, body: text.trim() };
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colon = trimmed.indexOf(':');
    if (colon <= 0) continue;
    const key = trimmed.slice(0, colon).trim().toLowerCase();
    let value = trimmed.slice(colon + 1).trim();
    if (value.length > 1 && /^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    fields[key] = value;
  }
  return { fields, body: text.slice(match[0].length).trim() };
}

const list = value => (value ? value.split(/[,\s]+/).map(entry => entry.trim()).filter(Boolean) : []);

export function toRole(file, text) {
  const { fields, body } = parseFrontmatter(text);
  return {
    name: fields.name || file,
    file,
    description: fields.description || fields.summary || '',
    model: fields.model || undefined,
    thinking: fields.thinking || undefined,
    tools: list(fields.tools),
    denyTools: list(fields['deny-tools'] || fields.denyTools),
    skills: list(fields.skills || fields.skill),
    cwd: fields.cwd || undefined,
    fork: fields.fork === undefined ? undefined : !/^(false|no|0)$/i.test(fields.fork),
    systemPrompt: body || undefined,
  };
}

// User roles first so that a project role of the same name wins.
export function roleDirectories(cwd, agentDir = agentDirectory()) {
  return [...(agentDir ? [join(agentDir, 'agents')] : []), ...(cwd ? [join(cwd, '.pi', 'agents')] : [])];
}

export function discoverRoles(cwd, agentDir = agentDirectory()) {
  const roles = new Map();
  for (const dir of roleDirectories(cwd, agentDir)) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isFile() || !/\.md$/i.test(entry.name)) continue;
      let text;
      try { text = readFileSync(join(dir, entry.name), 'utf8'); } catch { continue; }
      const role = toRole(entry.name.replace(/\.md$/i, ''), text);
      if (role.name) roles.set(role.name, role);
    }
  }
  return roles;
}

export function findRole(roles, wanted) {
  const key = String(wanted || '').trim();
  if (!key) return undefined;
  return roles.get(key) || [...roles.values()].find(role => role.file === key);
}

export function roleSummary(roles) {
  return [...roles.values()]
    .map(role => (role.description ? `${role.name} (${role.description})` : role.name))
    .join(', ');
}

// An explicit tool argument wins over the role, and the role wins over the
// parent. Nothing here ever invents a model: an unset role inherits as before.
export function applyRole(role, options, params = {}) {
  if (!role) return options;
  return {
    ...options,
    role: role.name,
    model: params.model || role.model || options.model,
    thinking: role.thinking || options.thinking,
    tools: role.tools.length ? role.tools.join(',') : undefined,
    denyTools: role.denyTools.length ? role.denyTools.join(',') : undefined,
    skills: role.skills.length ? role.skills : undefined,
    agentPrompt: role.systemPrompt,
  };
}
