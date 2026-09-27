'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmp } = require('./helpers');
const { ClaudeWatcher, GIT_CMD } = require('../../src/core/claudeWatcher');

function setup() {
  const dir = tmp('kmgit-claude-');
  const proj = path.join(dir, '-home-me-proj');
  fs.mkdirSync(proj);
  const log = path.join(proj, 'sess-1.jsonl');
  fs.writeFileSync(log, '');
  let now = Date.parse('2026-09-26T12:00:00Z');
  const clock = { now: () => now, advance: (ms) => { now += ms; } };
  const w = new ClaudeWatcher({ dir, quietMs: 60000, busyMs: 20000, now: clock.now });
  const append = (obj) => fs.appendFileSync(log, `${typeof obj === 'string' ? obj : JSON.stringify(obj)}\n`);
  return { dir, log, w, clock, append };
}

const edit = (t, file, cwd = '/home/me/proj') => ({
  type: 'assistant', sessionId: 'sess-1', cwd, gitBranch: 'main', timestamp: new Date(t).toISOString(),
  message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: file } }] },
});

test('watcher: history is read silently; only new edits raise events', () => {
  const { w, clock, append } = setup();
  append(edit(clock.now(), '/home/me/proj/old.js'));
  w.scan();
  const events = [];
  w.on('edit', (e) => events.push(e.file));
  append(edit(clock.now(), '/home/me/proj/new.js'));
  w.scan();
  assert.deepEqual(events, ['/home/me/proj/new.js']);
  const [s] = w.list();
  assert.equal(s.cwd, '/home/me/proj');
  assert.equal(s.editedCount, 2);
  assert.equal(s.active, true);
});

test('watcher: partial lines wait for the rest; malformed lines are skipped', () => {
  const { w, clock, log, append } = setup();
  w.scan();
  const events = [];
  w.on('edit', (e) => events.push(e.file));
  const line = JSON.stringify(edit(clock.now(), '/home/me/proj/a.js'));
  append('{not json at all');
  append('null');
  append('[1,2]');
  fs.appendFileSync(log, line.slice(0, 30));
  w.scan();
  assert.deepEqual(events, []);
  fs.appendFileSync(log, `${line.slice(30)}\n`);
  w.scan();
  assert.deepEqual(events, ['/home/me/proj/a.js']);
});

test('watcher: hostile paths from the log are ignored', () => {
  const { w, clock, append } = setup();
  w.scan();
  const events = [];
  w.on('edit', (e) => events.push(e.file));
  for (const bad of ['-rf', 'relative/x.js', `/${'a'.repeat(5000)}`, '/x\0y', 42, null, { a: 1 }]) {
    append(edit(clock.now(), bad, bad));
  }
  append({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: null }] } });
  append({ type: 'assistant', message: { content: 'text' } });
  w.scan();
  assert.deepEqual(events, []);
  assert.equal(w.list()[0].cwd, null);
});

test('watcher: "quiet" fires once after Claude stops editing', () => {
  const { w, clock, append } = setup();
  w.scan();
  const quiet = [];
  w.on('quiet', (e) => quiet.push(e.files));
  append(edit(clock.now(), '/home/me/proj/a.js'));
  append(edit(clock.now(), '/home/me/proj/b.js'));
  w.scan();
  clock.advance(30000); w.scan();
  assert.equal(quiet.length, 0);
  clock.advance(31000); w.scan();
  assert.deepEqual(quiet, [['/home/me/proj/a.js', '/home/me/proj/b.js']]);
  clock.advance(120000); w.scan();
  assert.equal(quiet.length, 1);
});

test('watcher: isBusy only while Claude is actively working in that folder', () => {
  const { w, clock, append } = setup();
  w.scan();
  append(edit(clock.now(), '/home/me/proj/src/a.js'));
  w.scan();
  assert.equal(w.isBusy('/home/me/proj'), true);
  assert.equal(w.isBusy('/home/me/other'), false);
  assert.equal(w.isBusy('/home/me/pro'), false); // prefix but not inside
  clock.advance(21000);
  assert.equal(w.isBusy('/home/me/proj'), false);
});

test('watcher: spots git commands Claude runs', () => {
  const { w, clock, append } = setup();
  w.scan();
  const cmds = [];
  w.on('git', (e) => cmds.push(e.verb));
  const bash = (command) => ({ type: 'assistant', sessionId: 'sess-1', timestamp: new Date(clock.now()).toISOString(), message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } });
  append(bash('git add -A && git commit -m "x"'));
  append(bash('git status'));
  append(bash('cd x; git push origin main'));
  append(bash('echo digit commit'));
  w.scan();
  assert.deepEqual(cmds, ['commit', 'push']);
  assert.equal(GIT_CMD.exec('git -C /tmp reset --hard')[1], 'reset');
});

test('watcher: big existing logs are only tail-read on first sight', () => {
  const { w, log, clock } = setup();
  const filler = `${JSON.stringify({ type: 'user', sessionId: 'sess-1', cwd: '/home/me/proj', timestamp: new Date(clock.now()).toISOString(), message: { content: 'x'.repeat(1000) } })}\n`;
  fs.writeFileSync(log, filler.repeat(1500)); // ~1.5 MB
  w.scan();
  assert.equal(w.list()[0].cwd, '/home/me/proj');
  assert.ok(w.files.get(log).offset === fs.statSync(log).size);
});

test('watcher: missing Claude folder is fine', () => {
  const w = new ClaudeWatcher({ dir: '/nonexistent/claude/projects' });
  w.scan();
  assert.deepEqual(w.list(), []);
});
