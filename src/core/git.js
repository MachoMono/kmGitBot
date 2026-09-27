'use strict';
// Everything the app does with git, written for people who never see git.
// Rules: never destroy work, never leave a repo mid-merge, always explain.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { rawGit, serialize, GitError, gitProcessIn } = require('./gitRunner');
const guardian = require('./guardian');

const FRIENDLY_GITIGNORE = `# Files Twig keeps out of your save points (you can edit this list)
node_modules/
__pycache__/
*.pyc
.venv/
venv/
.DS_Store
Thumbs.db
*.log
.env
.env.*
!.env.example
dist/
build/
.cache/
`;

const withRepo = (cwd, fn) => serialize(cwd, () => fn((args, opts) => rawGit(cwd, args, opts)));

async function repoRoot(dir) {
  const r = await rawGit(dir, ['rev-parse', '--show-toplevel'], { allowFail: true });
  return r.ok ? r.stdout.trim() : null;
}

async function isRepo(dir) {
  return (await repoRoot(dir)) !== null;
}

function kindOf(xy) {
  if (xy.includes('D')) return 'deleted';
  if (xy.includes('A')) return 'new';
  if (xy.includes('R') || xy.includes('C')) return 'renamed';
  return 'edited';
}

function parseStatus(out) {
  const res = { oid: null, branch: null, detached: false, upstream: null, ahead: 0, behind: 0, files: [] };
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i];
    if (!line) continue;
    if (line.startsWith('# ')) {
      const [, key, ...rest] = line.split(' ');
      const val = rest.join(' ');
      if (key === 'branch.oid') res.oid = val === '(initial)' ? null : val;
      else if (key === 'branch.head') {
        if (val === '(detached)') res.detached = true;
        else res.branch = val;
      } else if (key === 'branch.upstream') res.upstream = val;
      else if (key === 'branch.ab') {
        const m = /^\+(\d+) -(\d+)$/.exec(val);
        if (m) { res.ahead = Number(m[1]); res.behind = Number(m[2]); }
      }
      continue;
    }
    const type = line[0];
    const f = line.split(' ');
    if (type === '1') {
      res.files.push({ path: f.slice(8).join(' '), kind: kindOf(f[1]), xy: f[1] });
    } else if (type === '2') {
      const orig = parts[++i];
      res.files.push({ path: f.slice(9).join(' '), from: orig, kind: 'renamed', xy: f[1] });
    } else if (type === 'u') {
      res.files.push({ path: f.slice(10).join(' '), kind: 'conflict', xy: f[1] });
    } else if (type === '?') {
      res.files.push({ path: line.slice(2), kind: 'new', xy: '??' });
    }
  }
  return res;
}

async function gitDir(dir) {
  const r = await rawGit(dir, ['rev-parse', '--absolute-git-dir'], { allowFail: true });
  return r.ok ? r.stdout.trim() : null;
}

function inProgress(gd) {
  if (!gd) return null;
  const has = (p) => fs.existsSync(path.join(gd, p));
  if (has('MERGE_HEAD')) return 'merge';
  if (has('rebase-merge') || has('rebase-apply')) return 'rebase';
  if (has('CHERRY_PICK_HEAD')) return 'cherry-pick';
  if (has('REVERT_HEAD')) return 'revert';
  return null;
}

function lockInfo(gd, now = Date.now()) {
  if (!gd) return { locked: false, stale: false };
  try {
    const st = fs.statSync(path.join(gd, 'index.lock'));
    return { locked: true, stale: now - st.mtimeMs > 10 * 60 * 1000 };
  } catch {
    return { locked: false, stale: false };
  }
}

async function status(dir) {
  const root = await repoRoot(dir);
  if (!root) return { isRepo: false };
  const out = await rawGit(dir, ['--no-optional-locks', 'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']);
  const st = parseStatus(out);
  const gd = await gitDir(dir);
  const remotes = (await rawGit(dir, ['remote'], { allowFail: true })).stdout.split('\n').filter(Boolean);
  const lock = lockInfo(gd);
  if (lock.stale && gitProcessIn(root)) lock.stale = false; // old lock but git is still running here: not ours to take
  const progress = inProgress(gd);
  const needsHelp = st.detached ? 'detached' : progress ? progress : lock.stale ? 'lock' : null;
  return {
    isRepo: true,
    root,
    ...st,
    hasCommits: st.oid !== null,
    remotes,
    hasRemote: remotes.length > 0,
    inProgress: progress,
    lock,
    needsHelp,
  };
}

async function hasIdentity(run) {
  const n = await run(['config', 'user.name'], { allowFail: true });
  const e = await run(['config', 'user.email'], { allowFail: true });
  return n.ok && n.stdout.trim() && e.ok && e.stdout.trim();
}

function identityArgs(identity) {
  const name = (identity && identity.name) || 'Twig User';
  const email = (identity && identity.email) || 'twig@localhost';
  return ['-c', `user.name=${name}`, '-c', `user.email=${email}`];
}

// Fallback commit message: short, human, no AI needed.
function simpleMessage(files) {
  if (!files.length) return 'Save point';
  const verbs = { new: 'Add', edited: 'Update', deleted: 'Remove', renamed: 'Rename', conflict: 'Update' };
  const first = files[0];
  const name = path.basename(first.path);
  const allSame = files.every((f) => f.kind === first.kind);
  const verb = allSame ? verbs[first.kind] : 'Update';
  if (files.length === 1) return `${verb} ${name}`;
  return `${verb} ${name} and ${files.length - 1} other file${files.length > 2 ? 's' : ''}`;
}

async function init(dir) {
  return withRepo(dir, async (run) => {
    if (await repoRoot(dir)) return { ok: true, already: true };
    await run(['init', '-q', '-b', 'main']);
    const gi = path.join(dir, '.gitignore');
    if (!fs.existsSync(gi)) fs.writeFileSync(gi, FRIENDLY_GITIGNORE);
    return { ok: true, already: false };
  });
}

// Save my work: stage everything safe, then commit.
// makeMessage(files, diffText) may return a message (e.g. from AI); falls back to simpleMessage.
async function save(dir, { message, identity, makeMessage } = {}) {
  return withRepo(dir, async (run) => {
    const st = await status(dir);
    if (!st.isRepo) return { ok: false, reason: 'not-repo' };
    if (st.needsHelp) return { ok: false, reason: 'needs-help', needsHelp: st.needsHelp };
    if (!st.files.length) return { ok: true, nothing: true };

    const review = guardian.review(st.root, st.files);
    const excluded = new Set(review.exclude.map((x) => x.path));
    const toSave = st.files.filter((f) => !excluded.has(f.path));
    if (!toSave.length) return { ok: true, nothing: true, excluded: review.exclude };

    const pathspec = ['.', ...review.exclude.map((x) => `:(exclude,literal)${x.path}`)];
    await run(['add', '-A', '--', ...pathspec]);
    const staged = (await run(['diff', '--cached', '--name-only', '-z'])).split('\0').filter(Boolean);
    if (!staged.length) return { ok: true, nothing: true, excluded: review.exclude };

    let msg = (message || '').trim();
    if (!msg && makeMessage) {
      try {
        const diff = await run(['diff', '--cached', '--stat', '--patch', '--no-color', '--no-ext-diff'], { allowFail: true });
        msg = ((await makeMessage(toSave, diff.ok ? diff.stdout.slice(0, 8000) : '')) || '').trim();
      } catch { msg = ''; }
    }
    if (!msg) msg = simpleMessage(toSave);

    const idArgs = (await hasIdentity(run)) ? [] : identityArgs(identity);
    await run([...idArgs, 'commit', '-q', '--no-verify', '-m', msg]);
    const hash = (await run(['rev-parse', 'HEAD'])).trim();
    return { ok: true, hash, message: msg, count: staged.length, files: toSave, excluded: review.exclude };
  });
}

async function history(dir, limit = 50) {
  const st = await status(dir);
  if (!st.isRepo || !st.hasCommits) return [];
  const out = await rawGit(dir, ['log', `-n${limit}`, '--no-color', '--pretty=format:%x1e%H%x1f%h%x1f%an%x1f%aI%x1f%P%x1f%s', '--shortstat']);
  let unpushed = new Set();
  if (st.upstream) {
    const r = await rawGit(dir, ['rev-list', '@{u}..HEAD'], { allowFail: true });
    if (r.ok) unpushed = new Set(r.stdout.split('\n').filter(Boolean));
  } else {
    unpushed = null; // nothing has been backed up yet
  }
  return out.split('\x1e').filter((s) => s.trim()).map((rec) => {
    const [head, ...rest] = rec.split('\n');
    const [hash, short, author, date, parents, subject] = head.split('\x1f');
    const stat = rest.join(' ');
    const m = /(\d+) files? changed/.exec(stat);
    return {
      hash, short, author, date, subject,
      isMerge: parents.trim().split(' ').length > 1,
      filesChanged: m ? Number(m[1]) : 0,
      backedUp: unpushed ? !unpushed.has(hash) : false,
    };
  });
}

async function changesIn(dir, hash) {
  if (!/^[0-9a-f]{7,64}$/i.test(hash)) throw new Error('bad save point id');
  const out = await rawGit(dir, ['show', '--no-color', '--name-status', '-z', '--format=', hash]);
  const parts = out.split('\0').filter(Boolean);
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i].trim();
    if (code.startsWith('R') || code.startsWith('C')) {
      files.push({ kind: 'renamed', from: parts[i + 1], path: parts[i + 2] });
      i += 2;
    } else {
      const kind = code === 'A' ? 'new' : code === 'D' ? 'deleted' : 'edited';
      files.push({ kind, path: parts[++i] });
    }
  }
  return files;
}

// Undo a save point by making a new save point that reverses it. History is never rewritten.
async function undo(dir, hash, { identity } = {}) {
  if (!/^[0-9a-f]{7,64}$/i.test(hash)) throw new Error('bad save point id');
  return withRepo(dir, async (run) => {
    const st = await status(dir);
    if (st.needsHelp) return { ok: false, reason: 'needs-help', needsHelp: st.needsHelp };
    if (st.files.length) return { ok: false, reason: 'unsaved-changes' };
    const parents = (await run(['rev-list', '--parents', '-n1', hash])).trim().split(' ');
    if (parents.length > 2) return { ok: false, reason: 'merge-commit' };
    if (parents.length === 1) return { ok: false, reason: 'first-commit' };
    const idArgs = (await hasIdentity(run)) ? [] : identityArgs(identity);
    const r = await run([...idArgs, 'revert', '--no-edit', hash], { allowFail: true });
    if (!r.ok) {
      await run(['revert', '--abort'], { allowFail: true });
      return { ok: false, reason: 'conflict' };
    }
    return { ok: true, hash: (await run(['rev-parse', 'HEAD'])).trim() };
  });
}

// Bring a file back to how it was in a save point. Current version is kept in a backup first.
async function restoreFile(dir, hash, file) {
  if (!/^[0-9a-f]{7,64}$/i.test(hash)) throw new Error('bad save point id');
  if (typeof file !== 'string' || !file || file.startsWith('-') || path.isAbsolute(file) || file.split(/[\\/]/).includes('..')) {
    throw new Error('bad file name');
  }
  return withRepo(dir, async (run) => {
    let source = hash;
    const exists = await run(['cat-file', '-e', `${hash}:${file}`], { allowFail: true });
    if (!exists.ok) {
      source = `${hash}~1`;
      const before = await run(['cat-file', '-e', `${source}:${file}`], { allowFail: true });
      if (!before.ok) return { ok: false, reason: 'not-found' };
    }
    let backup = false;
    const dirty = (await run(['status', '--porcelain', '--', file])).trim();
    if (dirty) {
      const r = await run(['stash', 'push', '--include-untracked', '-m', `Twig backup of ${file} (${new Date().toISOString()})`, '--', file], { allowFail: true });
      backup = r.ok;
      if (!r.ok) return { ok: false, reason: 'backup-failed' };
    }
    await run(['restore', `--source=${source}`, '--worktree', '--', file]);
    return { ok: true, backup, source };
  });
}

async function push(dir) {
  return withRepo(dir, async (run) => {
    const st = await status(dir);
    if (!st.isRepo) return { ok: false, reason: 'not-repo' };
    if (st.needsHelp) return { ok: false, reason: 'needs-help', needsHelp: st.needsHelp };
    if (!st.hasCommits) return { ok: false, reason: 'no-commits' };
    if (!st.hasRemote) return { ok: false, reason: 'needs-remote' };
    const remote = st.remotes.includes('origin') ? 'origin' : st.remotes[0];
    const args = st.upstream ? ['push'] : ['push', '-u', remote, st.branch];
    const r = await run(args, { allowFail: true, timeout: 120000 });
    if (!r.ok) return { ok: false, reason: 'git-error', error: new GitError(args, r.code, r.stdout, r.stderr) };
    return { ok: true, firstTime: !st.upstream, count: st.upstream ? st.ahead : null };
  });
}

// Get the latest. Only runs on a clean tree, so if anything goes wrong we can put everything back exactly.
async function pull(dir, { identity } = {}) {
  return withRepo(dir, async (run) => {
    const st = await status(dir);
    if (!st.isRepo) return { ok: false, reason: 'not-repo' };
    if (st.needsHelp) return { ok: false, reason: 'needs-help', needsHelp: st.needsHelp };
    if (!st.hasRemote) return { ok: false, reason: 'needs-remote' };
    if (!st.upstream) return { ok: false, reason: 'no-upstream' };
    if (st.files.length) return { ok: false, reason: 'unsaved-changes' };
    const f = await run(['fetch', '--quiet'], { allowFail: true, timeout: 120000 });
    if (!f.ok) return { ok: false, reason: 'git-error', error: new GitError(['fetch'], f.code, f.stdout, f.stderr) };
    const behind = Number((await run(['rev-list', '--count', 'HEAD..@{u}'])).trim());
    if (!behind) return { ok: true, upToDate: true };
    const ff = await run(['merge', '--ff-only', '--quiet', '@{u}'], { allowFail: true });
    if (ff.ok) return { ok: true, count: behind, merged: false };
    const idArgs = (await hasIdentity(run)) ? [] : identityArgs(identity);
    const m = await run([...idArgs, 'merge', '--no-edit', '--quiet', '@{u}'], { allowFail: true });
    if (m.ok) return { ok: true, count: behind, merged: true };
    const conflicted = parseStatus(await run(['status', '--porcelain=v2', '-z'])).files.filter((x) => x.kind === 'conflict').map((x) => x.path);
    await run(['merge', '--abort'], { allowFail: true });
    return { ok: false, reason: 'conflict', files: conflicted };
  });
}

function backupFiles(root, gd, files) {
  const dest = path.join(gd, 'twig-backups', new Date().toISOString().replace(/[:.]/g, '-'));
  for (const f of files) {
    const src = path.join(root, f.path);
    try {
      if (!fs.statSync(src).isFile()) continue;
      fs.mkdirSync(path.dirname(path.join(dest, f.path)), { recursive: true });
      fs.copyFileSync(src, path.join(dest, f.path));
    } catch { /* deleted files have nothing to keep */ }
  }
  return dest;
}

function defaultBranchName(branches) {
  for (const b of ['main', 'master', 'trunk', 'develop']) if (branches.includes(b)) return b;
  return branches[0] || null;
}

// Detached HEAD rescue: keep any work on a rescue line, then go back to the main line.
async function rescue(dir, { identity } = {}) {
  return withRepo(dir, async (run) => {
    const st = await status(dir);
    if (st.needsHelp === 'lock') {
      if (!st.lock.stale || gitProcessIn(st.root)) return { ok: false, reason: 'busy' };
      fs.unlinkSync(path.join(await gitDir(dir), 'index.lock'));
      return { ok: true, fixed: 'lock' };
    }
    if (st.inProgress) {
      // Cancelling a half-finished merge can undo hand edits, so copy every touched file somewhere safe first.
      const backupDir = backupFiles(st.root, await gitDir(dir), st.files);
      await run([st.inProgress, '--abort'], { allowFail: true });
      return { ok: true, fixed: st.inProgress, backupDir };
    }
    if (!st.detached) return { ok: true, fixed: null };
    const branches = (await run(['branch', '--format=%(refname:short)'])).split('\n').map((s) => s.trim()).filter(Boolean);
    const target = defaultBranchName(branches);
    const head = (await run(['rev-parse', 'HEAD'])).trim();
    let rescueBranch = null;
    const reachable = target ? (await run(['merge-base', '--is-ancestor', head, target], { allowFail: true })).ok : false;
    if (st.files.length || !reachable || !target) {
      rescueBranch = `rescued-work-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`;
      await run(['switch', '-q', '-c', rescueBranch]);
      if (st.files.length) {
        await run(['add', '-A']);
        const idArgs = (await hasIdentity(run)) ? [] : identityArgs(identity);
        await run([...idArgs, 'commit', '-q', '--no-verify', '-m', 'Work rescued by Twig']);
      }
    }
    if (target) await run(['switch', '-q', target]);
    return { ok: true, fixed: 'detached', rescueBranch, target };
  });
}

function runGh(args, cwd) {
  return new Promise((resolve) => {
    execFile('gh', args, { cwd, timeout: 120000, env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || (err && err.message) || ''), missing: err && err.code === 'ENOENT' });
    });
  });
}

async function githubStatus() {
  const r = await runGh(['auth', 'status']);
  if (r.missing) return { installed: false, loggedIn: false };
  return { installed: true, loggedIn: r.ok };
}

function repoNameFor(dir) {
  return path.basename(dir).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+/, '') || 'my-project';
}

async function createGithubHome(dir) {
  return serialize(dir, async () => {
    const st = await status(dir);
    if (st.hasRemote) return { ok: false, reason: 'has-remote' };
    if (!st.hasCommits) return { ok: false, reason: 'no-commits' };
    const r = await runGh(['repo', 'create', repoNameFor(dir), '--private', '--source', dir, '--remote', 'origin', '--push'], dir);
    if (!r.ok) return { ok: false, reason: 'gh-error', message: r.stderr.trim() };
    return { ok: true, url: (r.stdout.match(/https:\/\/github\.com\/\S+/) || [null])[0] };
  });
}

module.exports = {
  isRepo, repoRoot, status, parseStatus, init, save, history, changesIn, undo, restoreFile,
  push, pull, rescue, githubStatus, createGithubHome, simpleMessage, lockInfo, repoNameFor,
  FRIENDLY_GITIGNORE,
};
