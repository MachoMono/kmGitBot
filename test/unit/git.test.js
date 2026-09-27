'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmp, g, write, repo, withRemote, snapshotTree, ID } = require('./helpers');
const git = require('../../src/core/git');
const { rawGit, safeRepoPath } = require('../../src/core/gitRunner');

test('status: plain folder is not a repo', async () => {
  assert.equal((await git.status(tmp())).isRepo, false);
});

test('status: describes new, edited, deleted, renamed and odd file names', async () => {
  const dir = repo();
  write(dir, 'gone.txt', 'x');
  write(dir, 'old name.txt', 'rename me please, enough content to detect\n'.repeat(5));
  g(dir, 'add', '-A'); g(dir, 'commit', '-qm', 'more');
  write(dir, 'README.md', 'changed\n');
  fs.unlinkSync(path.join(dir, 'gone.txt'));
  write(dir, 'sub dir/ñew file.md', 'hi');
  g(dir, 'mv', 'old name.txt', 'new name.txt');
  const st = await git.status(dir);
  const kinds = Object.fromEntries(st.files.map((f) => [f.path, f.kind]));
  assert.deepEqual(kinds, { 'README.md': 'edited', 'gone.txt': 'deleted', 'sub dir/ñew file.md': 'new', 'new name.txt': 'renamed' });
  assert.equal(st.branch, 'main');
  assert.equal(st.hasCommits, true);
  assert.equal(st.hasRemote, false);
  assert.equal(st.needsHelp, null);
});

test('init: starts watching a folder and adds a friendly .gitignore', async () => {
  const dir = tmp();
  write(dir, 'notes.txt', 'hi');
  const r = await git.init(dir);
  assert.equal(r.ok, true);
  assert.ok(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8').includes('node_modules/'));
  const st = await git.status(dir);
  assert.equal(st.isRepo, true);
  assert.equal(st.hasCommits, false);
  assert.equal((await git.init(dir)).already, true);
});

test('save: first save point works with no git identity configured', async () => {
  const dir = tmp();
  await git.init(dir);
  write(dir, 'a.txt', 'a');
  const r = await git.save(dir, { identity: ID });
  assert.equal(r.ok, true);
  assert.equal(r.message, 'Add .gitignore and 1 other file');
  assert.equal(g(dir, 'log', '-1', '--format=%an <%ae>').trim(), 'Test Person <test@example.com>');
  // no identity was written anywhere
  assert.equal(g(dir, 'config', '--list', '--local').includes('user.name'), false);
});

test('save: nothing to save is a happy no-op', async () => {
  const r = await git.save(repo(), { identity: ID });
  assert.deepEqual(r, { ok: true, nothing: true });
});

test('save: uses the AI message when given, falls back when AI fails', async () => {
  const dir = repo();
  write(dir, 'README.md', 'v2');
  let seenDiff = '';
  const r = await git.save(dir, { makeMessage: async (files, diff) => { seenDiff = diff; return 'Update the greeting'; } });
  assert.equal(r.message, 'Update the greeting');
  assert.match(seenDiff, /README\.md/);
  write(dir, 'README.md', 'v3');
  const r2 = await git.save(dir, { makeMessage: async () => { throw new Error('offline'); } });
  assert.equal(r2.message, 'Update README.md');
});

test('save: keeps secrets and huge files out of the save point', async () => {
  const dir = repo();
  write(dir, '.env', 'TOKEN=secret');
  write(dir, 'keys/id_rsa', 'PRIVATE');
  write(dir, '.env.example', 'TOKEN=');
  write(dir, 'ok.txt', 'fine');
  const big = path.join(dir, 'video.mp4');
  const fd = fs.openSync(big, 'w'); fs.ftruncateSync(fd, 96 * 1024 * 1024); fs.closeSync(fd); // sparse, instant
  const r = await git.save(dir, { identity: ID });
  assert.equal(r.ok, true);
  const committed = g(dir, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort();
  assert.deepEqual(committed, ['.env.example', 'ok.txt']);
  assert.deepEqual(r.excluded.map((x) => `${x.path}:${x.reason}`).sort(), ['.env:secret', 'keys/id_rsa:secret', 'video.mp4:big']);
});

test('history: lists save points newest first with backup state', async () => {
  const { dir } = withRemote();
  write(dir, 'b.txt', 'b'); await git.save(dir);
  const h = await git.history(dir);
  assert.equal(h.length, 2);
  assert.equal(h[0].subject, 'Add b.txt');
  assert.equal(h[0].backedUp, false);
  assert.equal(h[1].backedUp, true);
  assert.equal(h[0].filesChanged, 1);
  assert.deepEqual(await git.changesIn(dir, h[0].hash), [{ kind: 'new', path: 'b.txt' }]);
});

test('undo: reverses a save point with a new one; history is kept', async () => {
  const dir = repo();
  write(dir, 'README.md', 'oops\n'); await git.save(dir);
  const [bad] = await git.history(dir);
  const r = await git.undo(dir, bad.hash);
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), 'hello\n');
  assert.equal((await git.history(dir)).length, 3);
});

test('undo: refuses with unsaved changes, and on the first save point', async () => {
  const dir = repo();
  const [first] = await git.history(dir);
  assert.equal((await git.undo(dir, first.hash)).reason, 'first-commit');
  write(dir, 'README.md', 'dirty');
  assert.equal((await git.undo(dir, first.hash)).reason, 'unsaved-changes');
});

test('undo: a conflicting undo is cancelled cleanly', async () => {
  const dir = repo();
  write(dir, 'README.md', 'two\n'); await git.save(dir);
  const [two] = await git.history(dir);
  write(dir, 'README.md', 'three\n'); await git.save(dir);
  const before = snapshotTree(dir);
  const r = await git.undo(dir, two.hash);
  assert.equal(r.reason, 'conflict');
  assert.deepEqual(snapshotTree(dir), before);
  assert.equal((await git.status(dir)).needsHelp, null);
});

test('restoreFile: brings a file back and keeps the current version in a backup', async () => {
  const dir = repo();
  const [first] = await git.history(dir);
  write(dir, 'README.md', 'my unsaved words\n');
  const r = await git.restoreFile(dir, first.hash, 'README.md');
  assert.equal(r.ok, true);
  assert.equal(r.backup, true);
  assert.equal(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), 'hello\n');
  assert.match(g(dir, 'stash', 'list'), /Twig backup of README\.md/);
  assert.match(g(dir, 'stash', 'show', '-p', 'stash@{0}'), /my unsaved words/);
});

test('restoreFile: a file deleted in a save point comes back from just before it', async () => {
  const dir = repo();
  fs.unlinkSync(path.join(dir, 'README.md')); await git.save(dir);
  const [del] = await git.history(dir);
  const r = await git.restoreFile(dir, del.hash, 'README.md');
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), 'hello\n');
});

test('restoreFile: rejects sneaky file names', async () => {
  const dir = repo();
  const [first] = await git.history(dir);
  for (const bad of ['../etc/passwd', '/etc/passwd', '--help', '']) {
    await assert.rejects(git.restoreFile(dir, first.hash, bad), /bad file name/);
  }
  await assert.rejects(git.restoreFile(dir, 'HEAD; rm -rf /', 'README.md'), /bad save point id/);
});

test('push: no remote → needs-remote; first push sets up tracking', async () => {
  const dir = repo();
  assert.equal((await git.push(dir)).reason, 'needs-remote');
  const remote = tmp(); g(remote, 'init', '-q', '--bare', '-b', 'main');
  g(dir, 'remote', 'add', 'origin', remote);
  const r = await git.push(dir);
  assert.equal(r.ok, true);
  assert.equal(r.firstTime, true);
  assert.equal((await git.status(dir)).upstream, 'origin/main');
});

test('push: rejected when GitHub has newer work → translated error', async () => {
  const { dir, other } = withRemote();
  write(other, 'x.txt', 'x'); g(other, 'add', '-A'); g(other, 'commit', '-qm', 'other'); g(other, 'push', '-q');
  write(dir, 'y.txt', 'y'); await git.save(dir);
  const r = await git.push(dir);
  assert.equal(r.ok, false);
  assert.equal(require('../../src/core/explain').fromResult(r).key, 'behind');
});

test('push: unreachable remote fails fast without prompting', async () => {
  const dir = repo();
  g(dir, 'remote', 'add', 'origin', 'https://invalid.invalid/nope.git');
  const r = await git.push(dir);
  assert.equal(r.ok, false);
  assert.equal(require('../../src/core/explain').fromResult(r).key, 'offline');
});

test('pull: up to date, then fast-forward', async () => {
  const { dir, other } = withRemote();
  assert.equal((await git.pull(dir)).upToDate, true);
  write(other, 'x.txt', 'x'); g(other, 'add', '-A'); g(other, 'commit', '-qm', 'other'); g(other, 'push', '-q');
  const r = await git.pull(dir);
  assert.deepEqual(r, { ok: true, count: 1, merged: false });
  assert.equal(fs.readFileSync(path.join(dir, 'x.txt'), 'utf8'), 'x');
});

test('pull: diverged but different files → combined automatically', async () => {
  const { dir, other } = withRemote();
  write(other, 'x.txt', 'x'); g(other, 'add', '-A'); g(other, 'commit', '-qm', 'other'); g(other, 'push', '-q');
  write(dir, 'y.txt', 'y'); await git.save(dir);
  const r = await git.pull(dir);
  assert.equal(r.ok, true);
  assert.equal(r.merged, true);
  assert.ok(fs.existsSync(path.join(dir, 'x.txt')) && fs.existsSync(path.join(dir, 'y.txt')));
});

test('pull: conflict is cancelled and the working tree is byte-identical to before', async () => {
  const { dir, other } = withRemote();
  write(other, 'README.md', 'theirs\n'); g(other, 'commit', '-qam', 'theirs'); g(other, 'push', '-q');
  write(dir, 'README.md', 'mine\n'); await git.save(dir);
  const before = snapshotTree(dir);
  const headBefore = g(dir, 'rev-parse', 'HEAD');
  const r = await git.pull(dir);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'conflict');
  assert.deepEqual(r.files, ['README.md']);
  assert.deepEqual(snapshotTree(dir), before);
  assert.equal(g(dir, 'rev-parse', 'HEAD'), headBefore);
  const st = await git.status(dir);
  assert.equal(st.needsHelp, null);
  assert.equal(st.files.length, 0);
});

test('pull: refuses while there are unsaved changes', async () => {
  const { dir } = withRemote();
  write(dir, 'README.md', 'dirty');
  assert.equal((await git.pull(dir)).reason, 'unsaved-changes');
});

test('detached HEAD: flagged as needs-help and rescued without losing work', async () => {
  const dir = repo();
  write(dir, 'README.md', 'second\n'); await git.save(dir);
  g(dir, 'checkout', '-q', 'HEAD~1');
  write(dir, 'lost.txt', 'precious');
  const st = await git.status(dir);
  assert.equal(st.needsHelp, 'detached');
  assert.equal((await git.save(dir)).reason, 'needs-help');
  const r = await git.rescue(dir, { identity: ID });
  assert.equal(r.ok, true);
  assert.equal(r.target, 'main');
  assert.match(r.rescueBranch, /^rescued-work-/);
  assert.equal((await git.status(dir)).branch, 'main');
  assert.equal(g(dir, 'show', `${r.rescueBranch}:lost.txt`), 'precious');
});

test('half-finished merge: flagged, then cancelled with a backup of touched files', async () => {
  const { dir, other } = withRemote();
  write(other, 'README.md', 'theirs\n'); g(other, 'commit', '-qam', 'theirs'); g(other, 'push', '-q');
  write(dir, 'README.md', 'mine\n'); g(dir, 'commit', '-qam', 'mine');
  g(dir, 'fetch', '-q');
  try { g(dir, 'merge', 'origin/main'); } catch { /* conflict expected */ }
  assert.equal((await git.status(dir)).needsHelp, 'merge');
  const r = await git.rescue(dir);
  assert.equal(r.fixed, 'merge');
  assert.match(fs.readFileSync(path.join(r.backupDir, 'README.md'), 'utf8'), /<<<<<<<|mine/);
  assert.equal((await git.status(dir)).needsHelp, null);
  assert.equal(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), 'mine\n');
});

test('stale index.lock: detected and cleared; fresh lock left alone', async () => {
  const dir = repo();
  const lock = path.join(dir, '.git', 'index.lock');
  fs.writeFileSync(lock, '');
  assert.equal((await git.status(dir)).needsHelp, null); // fresh lock: someone may be working
  const old = new Date(Date.now() - 20 * 60 * 1000);
  fs.utimesSync(lock, old, old);
  assert.equal((await git.status(dir)).needsHelp, 'lock');
  assert.equal((await git.rescue(dir)).fixed, 'lock');
  assert.equal(fs.existsSync(lock), false);
});

test('runner: refuses destructive commands outright', async () => {
  const dir = repo();
  for (const args of [['reset', '--hard'], ['push', '--force'], ['push', '--force-with-lease'], ['clean', '-fd'], ['branch', '-D', 'x'], ['checkout', '--', '.']]) {
    await assert.rejects(rawGit(dir, args), /Refusing unsafe git command/);
  }
});

test('runner: safeRepoPath rejects hostile paths', () => {
  const dir = repo();
  assert.equal(safeRepoPath(dir), dir);
  for (const bad of ['relative/path', '-rf', '/nonexistent/xyz', 'x'.repeat(5000), `${dir}\0evil`, null, 42]) {
    assert.equal(safeRepoPath(bad), null);
  }
});

test('repoNameFor makes a GitHub-safe name', () => {
  assert.equal(git.repoNameFor('/home/a/My Cool Project!'), 'My-Cool-Project-');
  assert.equal(git.repoNameFor('/home/a/.hidden'), 'hidden');
});
