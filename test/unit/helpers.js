'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
// Keep tests independent of the developer's own git config.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

function tmp(prefix = 'kmgit-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function g(cwd, ...args) {
  return execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

const ID = { name: 'Test Person', email: 'test@example.com' };

function write(dir, file, text) {
  const p = path.join(dir, file);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

// A repo with one save point.
function repo() {
  const dir = tmp();
  g(dir, 'init', '-q', '-b', 'main');
  g(dir, 'config', 'user.name', ID.name);
  g(dir, 'config', 'user.email', ID.email);
  write(dir, 'README.md', 'hello\n');
  g(dir, 'add', '-A');
  g(dir, 'commit', '-qm', 'first');
  return dir;
}

// A repo pushed to a bare "GitHub", plus a second clone ("the other computer").
function withRemote() {
  const remote = tmp('kmgit-remote-');
  g(remote, 'init', '-q', '--bare', '-b', 'main');
  const dir = repo();
  g(dir, 'remote', 'add', 'origin', remote);
  g(dir, 'push', '-q', '-u', 'origin', 'main');
  const other = tmp('kmgit-other-');
  g(other, 'clone', '-q', remote, '.');
  g(other, 'config', 'user.name', 'Other');
  g(other, 'config', 'user.email', 'other@example.com');
  return { dir, remote, other };
}

function snapshotTree(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = fs.readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
}

module.exports = { tmp, g, write, repo, withRemote, snapshotTree, ID };
