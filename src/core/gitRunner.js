'use strict';
// Runs git safely: no shell, never prompts, stable English output, one op per repo at a time.
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

// Commands the app is never allowed to run, whatever calls it.
const FORBIDDEN = [
  (a) => a[0] === 'reset' && a.includes('--hard'),
  (a) => a[0] === 'push' && a.some((x) => x === '--force' || x === '-f' || x.startsWith('--force')),
  (a) => a[0] === 'clean',
  (a) => a[0] === 'branch' && a.includes('-D'),
  (a) => a[0] === 'checkout' && a.includes('--'),
];

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

module.exports = { git, rawGit, serialize, safeRepoPath, GitError, FORBIDDEN };
