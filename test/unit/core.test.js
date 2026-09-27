'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmp } = require('./helpers');
const mascot = require('../../src/core/mascot');
const lessons = require('../../src/core/lessons');
const explain = require('../../src/core/explain');
const guardian = require('../../src/core/guardian');
const { Store } = require('../../src/core/store');
const ai = require('../../src/core/ai');

// ---------- mascot ----------
test('mascot: level curve', () => {
  assert.deepEqual([1, 2, 3, 4, 5].map(mascot.xpToReach), [0, 50, 150, 300, 500]);
  assert.equal(mascot.levelFor(0), 1);
  assert.equal(mascot.levelFor(49), 1);
  assert.equal(mascot.levelFor(50), 2);
  assert.equal(mascot.levelFor(299), 3);
  assert.equal(mascot.levelFor(300), 4);
});

test('mascot: first save gives a badge and bonus, then normal XP', () => {
  const m = { xp: 0, firsts: {}, saveTimes: [] };
  const a = mascot.award(m, 'save', 1000);
  assert.equal(a.gained, 35);
  assert.equal(a.badge, 'First save point!');
  const b = mascot.award(m, 'save', 2000);
  assert.equal(b.gained, 10);
  assert.equal(b.badge, null);
  assert.equal(b.levelUp, false); // 35 + 10 = 45, level 2 starts at 50
});

test('mascot: level up and stage up are reported', () => {
  const m = { xp: 45, firsts: { save: 1 }, saveTimes: [] };
  const r = mascot.award(m, 'save', 0);
  assert.equal(r.level, 2);
  assert.equal(r.levelUp, true);
  assert.equal(r.stageUp, true);
  assert.equal(r.stage.id, 'sprout');
  const r2 = mascot.award(m, 'pull', 0);
  assert.equal(r2.levelUp, false);
});

test('mascot: spam-saving stops earning after 6 in an hour', () => {
  const m = { xp: 0, firsts: { save: 1 }, saveTimes: [] };
  const t0 = 1_000_000;
  const gains = Array.from({ length: 8 }, (_, i) => mascot.award(m, 'save', t0 + i * 1000).gained);
  assert.deepEqual(gains, [10, 10, 10, 10, 10, 10, 0, 0]);
  assert.equal(mascot.award(m, 'save', t0 + 3601 * 1000).gained, 10);
});

test('mascot: stages grow all the way to Grand Oak', () => {
  assert.deepEqual([1, 2, 4, 7, 11, 20].map((l) => mascot.stageFor(l).id), ['seed', 'sprout', 'sapling', 'young', 'oak', 'oak']);
  assert.throws(() => mascot.award({ xp: 0 }, 'hack'), /unknown action/);
});

// ---------- lessons ----------
test('lessons: shown after the matching action, again only a day later, at most twice', () => {
  const now = 10 * 86400000;
  assert.equal(lessons.forEvent('save', {}, {}, now).word, 'commit');
  assert.equal(lessons.forEvent('save', { commit: 1 }, { commit: now - 3600000 }, now), null);
  assert.equal(lessons.forEvent('save', { commit: 1 }, { commit: now - 90000000 }, now).id, 'commit');
  assert.equal(lessons.forEvent('save', { commit: 2 }, {}, now), null);
  assert.equal(lessons.forEvent('nope', {}), null);
  const ids = lessons.LESSONS.map((l) => l.id);
  assert.equal(new Set(ids).size, ids.length);
});

// ---------- explain ----------
const cases = [
  ['fatal: unable to access \'https://x/\': Could not resolve host: x', 'offline'],
  ['fatal: could not read Username for \'https://github.com\': terminal prompts disabled', 'auth'],
  ['git@github.com: Permission denied (publickey).', 'auth'],
  [' ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs', 'behind'],
  ['remote: error: GH001: Large files detected.', 'too-big'],
  ["fatal: Unable to create '/x/.git/index.lock': File exists.", 'lock'],
  ['*** Please tell me who you are.', 'identity'],
  ['fatal: not a git repository (or any of the parent directories): .git', 'not-repo'],
  ['ERROR: Repository not found.', 'no-repo-online'],
  ['something totally new', 'unknown'],
];
for (const [stderr, key] of cases) {
  test(`explain: "${stderr.slice(0, 40)}" → ${key}`, () => {
    assert.equal(explain.fromGitError({ stderr }).key, key);
  });
}

test('explain: every message the user can read avoids scary git words', () => {
  const texts = [];
  for (const [, m] of explain.PATTERNS) texts.push(m.title, m.body);
  for (const m of Object.values(explain.REASONS)) texts.push(m.title, m.body);
  for (const m of Object.values(explain.HELP)) texts.push(m.title, m.body);
  for (const l of lessons.LESSONS) texts.push(l.title);
  for (const t of texts) assert.deepEqual(explain.hasBannedWords(t), [], t);
});

test('explain: status summary has icon + words for every state (not colour alone)', () => {
  const base = { isRepo: true, files: [], hasCommits: true, hasRemote: true, upstream: 'origin/main', ahead: 0, behind: 0, needsHelp: null };
  const states = [
    null,
    { ...base, needsHelp: 'detached' },
    { ...base, files: [{ path: 'a', kind: 'new' }] },
    { ...base, hasCommits: false },
    { ...base, hasRemote: false },
    { ...base, ahead: 2 },
    { ...base, behind: 1 },
    base,
  ];
  const seen = new Set();
  for (const s of states) {
    const sum = explain.summarizeStatus(s);
    assert.ok(sum.icon && sum.label && sum.detail);
    seen.add(sum.state);
  }
  assert.equal(seen.size, 8);
});

// ---------- guardian ----------
test('guardian: recognises secret files but not examples', () => {
  for (const f of ['.env', 'app/.env.local', 'server.pem', 'id_ed25519', 'credentials.json', 'x.key']) assert.equal(guardian.isSecretName(f), true, f);
  for (const f of ['.env.example', 'README.md', 'env.js', 'keyboard.txt', 'id_rsa.pub']) assert.equal(guardian.isSecretName(f), false, f);
});

test('guardian: ignoreForever appends once', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/');
  assert.equal(guardian.ignoreForever(dir, ['.env', 'big.mp4']), 2);
  assert.equal(guardian.ignoreForever(dir, ['.env']), 0);
  assert.equal(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), 'node_modules/\n# Kept out by Twig\n/.env\n/big.mp4\n');
});

// ---------- store ----------
test('store: round-trips, merges new defaults, recovers from a corrupt file', () => {
  const dir = tmp();
  const s = new Store(dir);
  s.update((d) => { d.user.name = 'Sam'; d.mascot.xp = 42; });
  const s2 = new Store(dir);
  assert.equal(s2.data.user.name, 'Sam');
  assert.equal(s2.data.mascot.xp, 42);
  assert.equal(s2.data.settings.ai, true);
  fs.writeFileSync(path.join(dir, 'state.json'), '{not json');
  const s3 = new Store(dir);
  assert.equal(s3.data.mascot.xp, 0);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('state.json.broken-')));
  assert.equal(fs.readdirSync(dir).some((f) => f.endsWith('.tmp')), false);
});

// ---------- ai ----------
function fakeClaude(script) {
  const dir = tmp();
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return bin;
}

test('ai: only Haiku and Sonnet can ever be called', async () => {
  assert.equal(ai.MODELS.commitMessage, 'haiku');
  assert.equal(ai.MODELS.explain, 'sonnet');
  for (const m of ['opus', 'fable', 'claude-opus-5-5', 'claude-fable-5-1', 'default', '']) {
    await assert.rejects(ai.ask(m, 'hi', { bin: '/bin/true' }), /not allowed/);
  }
});

test('ai: passes the right flags and cleans the reply', async () => {
  const bin = fakeClaude('cat > /dev/null; echo "\\"Update the README greeting.\\"" ; echo "$@" >&2');
  const msg = await ai.commitMessage([{ kind: 'edited', path: 'README.md' }], 'diff', { bin });
  assert.equal(msg, 'Update the README greeting');
  const args = fakeClaude('cat > /dev/null; echo "$@"');
  const out = await ai.ask('haiku', 'x', { bin: args });
  assert.equal(out, '-p --model haiku --no-session-persistence --tools  --strict-mcp-config --mcp-config {"mcpServers":{}} --disable-slash-commands --output-format text');
});

test('ai: missing CLI, failure and timeout all reject (caller falls back)', async () => {
  await assert.rejects(ai.ask('haiku', 'x', { bin: '/nonexistent/claude' }));
  await assert.rejects(ai.ask('haiku', 'x', { bin: fakeClaude('exit 3') }), /exited 3/);
  await assert.rejects(ai.ask('haiku', 'x', { bin: fakeClaude('sleep 5'), timeout: 200 }), /timed out/);
});

test('ai: cleanMessage trims long and quoted replies', () => {
  assert.equal(ai.cleanMessage('Commit message: `Fix typo`\n\nmore'), 'Fix typo');
  assert.equal(ai.cleanMessage('x'.repeat(100)).length, 72);
});

test('guardian: wider secret names and token shapes inside files', () => {
  for (const f of ['.npmrc', 'home/.aws/credentials', 'config/secrets.yml', '.git-credentials', 'x/.ssh/config', 'vault.kdbx']) assert.equal(guardian.isSecretName(f), true, f);
  const dir = tmp();
  const files = {
    'notes.md': 'my github token is ghp_abcdefghijklmnopqrstuvwxyz0123456789AB',
    'config.js': 'const key = "AKIAABCDEFGHIJKLMNOP";',
    'id.txt': '-----BEGIN OPENSSH PRIVATE KEY-----\nabc',
    'clean.md': 'nothing secret here, just sk- talk',
  };
  for (const [n, t] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), t);
  const out = guardian.review(dir, Object.keys(files).map((p) => ({ path: p, kind: 'new' }))).exclude.map((x) => x.path).sort();
  assert.deepEqual(out, ['config.js', 'id.txt', 'notes.md']);
});
