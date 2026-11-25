import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_CONFIG = Object.freeze({ language: 'en', closeFinishedAgentsOnExit: true });

// `--dry-run` belongs to this loader, not to Pi: Pi's own CLI rejects options it
// does not know, so the argv to inspect is passed in (Pi's process.argv by
// default) instead of being read off the command line. Everything after a bare
// `--` is a positional prompt, so a task mentioning the flag never triggers it.
export const DRY_RUN_FLAG = '--dry-run';

export function isDryRun(argv = process.argv) {
  for (const arg of argv.slice(2)) {
    if (arg === '--') return false;
    if (arg === DRY_RUN_FLAG) return true;
  }
  return false;
}

// Separate extension settings: never rewrite Pi's settings.json or create files
// on startup. Read once per session/reload; project fields override global ones.
// A dry run resolves and explains the same values without applying them: it adds
// the report, and every caller that applies `config` checks `dryRun` first.
export async function loadConfig(
  cwd, { env = process.env, home = homedir(), argv = process.argv } = {}) {
  const dryRun = isDryRun(argv);
  const configuredDir = env.PI_CODING_AGENT_DIR;
  const agentDir = configuredDir
    ? configuredDir.replace(/^~(?=$|\/)/, home) : join(home, '.pi', 'agent');
  const candidates = [join(agentDir, 'rex.json'), ...(cwd ? [join(cwd, '.pi', 'rex.json')] : [])];
  const config = { ...DEFAULT_CONFIG }, errors = [], files = [];
  // Which file won each key, so a dry run can tell a configured value from a
  // default one instead of showing a flat merge.
  const sources = Object.fromEntries(Object.keys(DEFAULT_CONFIG).map(key => [key, 'default']));
  for (const file of new Set(candidates)) {
    const entry = { path: file, read: false };
    files.push(entry);
    let text;
    try { text = await readFile(file, 'utf8'); }
    catch (error) {
      if (error.code !== 'ENOENT') { entry.read = true; errors.push(`${file}: ${error.message}`); }
      continue;
    }
    entry.read = true;
    try {
      const value = JSON.parse(text);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object');
      for (const [key, item] of Object.entries(value)) {
        if (key === 'language') {
          if (['en', 'zh'].includes(item)) { config.language = item; sources.language = file; }
          else errors.push(`${file}: language must be "en" or "zh"`);
        } else if (key === 'closeFinishedAgentsOnExit') {
          if (typeof item === 'boolean') { config.closeFinishedAgentsOnExit = item; sources.closeFinishedAgentsOnExit = file; }
          else errors.push(`${file}: closeFinishedAgentsOnExit must be true or false`);
        } else errors.push(`${file}: Unknown setting: ${key}`);
      }
    } catch (error) { errors.push(`${file}: ${error.message}`); }
  }
  if (!dryRun) return { config, errors };
  return { config, errors, dryRun: true, sources, files };
}

// The dry run's user-facing half: what the files resolved to and why. Errors are
// printed last because they explain every value that fell back to an inherited
// or default one.
export function formatConfigReport(result) {
  if (!result?.dryRun) throw new Error('formatConfigReport needs a dry-run result');
  const lines = ['Rex configuration (dry run — nothing applied)'];
  for (const [key, value] of Object.entries(result.config)) {
    const source = result.sources[key];
    lines.push(`  ${key} = ${JSON.stringify(value)}  (${source === 'default' ? 'default' : source})`);
  }
  for (const file of result.files) lines.push(`  ${file.read ? 'read' : 'missing'}: ${file.path}`);
  if (result.errors.length) {
    lines.push(`  ${result.errors.length} problem${result.errors.length === 1 ? '' : 's'}:`,
      ...result.errors.map(error => `  ${error}`));
  }
  return lines.join('\n');
}
