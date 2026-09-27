'use strict';
// Runs git safely: no shell, never prompts, stable English output, one op per repo at a time.
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

// Commands the app is never allowed to run, whatever calls it.
// Checked against the subcommand wherever it sits (after any leading `-c k=v` pairs).
const has = (a, ...flags) => a.some((x) => flags.some((f) => x === f || x.startsWith(`${f}=`)));
const FORBIDDEN_RULES = [
  (a) => a[0] === 'reset' && has(a, '--hard', '--merge', '--keep'),
  (a) => a[0] === 'push' && (has(a, '--force', '--force-with-lease', '--force-if-includes', '--mirror', '--delete', '-d') || a.includes('-f') || a.some((x) => x.startsWith('+'))),
  (a) => a[0] === 'clean',
  (a) => a[0] === 'branch' && (a.includes('-D') || has(a, '--force') || a.includes('-f')),
  (a) => a[0] === 'checkout' && (a.includes('--') || a.includes('-f') || has(a, '--force') || a.includes('.')),
  (a) => a[0] === 'switch' && (a.includes('-f') || has(a, '--force', '--discard-changes') || a.includes('-C')),
  (a) => a[0] === 'stash' && (a[1] === 'clear' || a[1] === 'drop' || a[1] === 'pop'),
  (a) => a[0] === 'restore' && !a.some((x) => x.startsWith('--source=')),
  (a) => a[0] === 'update-ref' || a[0] === 'filter-branch' || a[0] === 'gc' || a[0] === 'prune' || (a[0] === 'reflog' && a[1] !== 'show'),
];
function subcommand(args) {
  let i = 0;
  while (args[i] === '-c' || args[i] === '--no-optional-locks') i += args[i] === '-c' ? 2 : 1;
  return args.slice(i);
}
const FORBIDDEN = FORBIDDEN_RULES.map((rule) => (a) => rule(subcommand(a)));

class GitError extends Error {
  constructor(args, code, stdout, stderr) {
    super(`git ${args.join(' ')} failed (${code}): ${stderr.trim() || stdout.trim()}`);
    this.args = args;
    this.code = code;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

// Validate a folder path that came from anywhere outside our own code.
function safeRepoPath(p) {
  if (typeof p !== 'string' || !p || p.length > 4096) return null;
  if (!path.isAbsolute(p) || p.startsWith('-') || p.includes('\0')) return null;
  try {
    const real = fs.realpathSync(p);
    return fs.statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

const queues = new Map();
function serialize(key, fn) {
  const prev = queues.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  queues.set(key, next);
  next.finally(() => { if (queues.get(key) === next) queues.delete(key); }).catch(() => {});
  return next;
}

function baseEnv(extra) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', LANG: 'C', GIT_EDITOR: 'true', GIT_MERGE_AUTOEDIT: 'no', ...extra };
  // An askpass helper would pop dialogs; we want a clean failure instead.
  delete env.GIT_ASKPASS;
  delete env.SSH_ASKPASS;
  env.GIT_SSH_COMMAND = env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes';
  return env;
}

function rawGit(cwd, args, opts = {}) {
  if (FORBIDDEN.some((f) => f(args))) {
    return Promise.reject(new Error(`Refusing unsafe git command: git ${args.join(' ')}`));
  }
  return new Promise((resolve, reject) => {
    execFile('git', ['-c', 'core.quotepath=false', ...args], {
      cwd,
      env: baseEnv(opts.env),
      timeout: opts.timeout || 60000,
      maxBuffer: 20 * 1024 * 1024,
      encoding: opts.encoding || 'utf8',
    }, (err, stdout, stderr) => {
      if (err) {
        const code = typeof err.code === 'number' ? err.code : (err.killed ? 'timeout' : err.code);
        if (opts.allowFail) return resolve({ ok: false, code, stdout: String(stdout), stderr: String(stderr) });
        return reject(new GitError(args, code, String(stdout || ''), String(stderr || err.message)));
      }
      resolve(opts.allowFail ? { ok: true, code: 0, stdout, stderr } : stdout);
    });
  });
}

// Queued variant for anything that writes.
function git(cwd, args, opts) {
  return serialize(cwd, () => rawGit(cwd, args, opts));
}

// Is any git process running with its working directory inside this folder? (Linux /proc)
function gitProcessIn(root) {
  let pids = [];
  try { pids = fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x)); } catch { return false; }
  for (const pid of pids) {
    try {
      if (fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim() !== 'git') continue;
      const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
      const rel = path.relative(root, cwd);
      if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return true;
    } catch { /* process gone or not ours */ }
  }
  return false;
}

module.exports = { gitProcessIn, git, rawGit, serialize, safeRepoPath, GitError, FORBIDDEN };
