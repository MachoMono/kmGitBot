'use strict';
// Keeps things out of save points that shouldn't be there: secrets and files too big for GitHub.
const fs = require('fs');
const path = require('path');

const BIG_BYTES = 95 * 1024 * 1024;
const SAFE_ENV = new Set(['.env.example', '.env.sample', '.env.template', '.env.dist']);
const SECRET_PATTERNS = [
  /^\.env$/,
  /^\.env\..+$/,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)$/,
  /^credentials\.json$/i,
  /^service[-_]account.*\.json$/i,
  /^\.netrc$/,
  /^\.pgpass$/,
  /^\.npmrc$/,
  /^\.pypirc$/,
  /^\.git-credentials$/,
  /^secrets?\.(ya?ml|json|toml|env)$/i,
  /\.(keystore|jks|ovpn|kdbx)$/i,
];
const SECRET_DIRS = [/(^|\/)\.aws\/credentials$/, /(^|\/)\.ssh\//, /(^|\/)\.docker\/config\.json$/];
// Well-known token shapes, checked inside small text files.
const TOKEN_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/,
  /\bsk-(proj-)?[A-Za-z0-9_-]{32,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
];
const SCAN_BYTES = 512 * 1024;

function hasToken(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > SCAN_BYTES) return false;
    const buf = fs.readFileSync(file);
    if (buf.includes(0)) return false; // binary
    const text = buf.toString('utf8');
    return TOKEN_PATTERNS.some((re) => re.test(text));
  } catch {
    return false;
  }
}

function isSecretName(file) {
  const base = path.basename(file);
  if (SAFE_ENV.has(base)) return false;
  const norm = file.replace(/\\/g, '/');
  return SECRET_PATTERNS.some((re) => re.test(base)) || SECRET_DIRS.some((re) => re.test(norm));
}

// files: [{ path, kind }] relative to root. Returns what to leave out and why.
function review(root, files) {
  const exclude = [];
  for (const f of files) {
    if (f.kind === 'deleted') continue;
    if (isSecretName(f.path)) {
      exclude.push({ path: f.path, reason: 'secret' });
      continue;
    }
    const full = path.join(root, f.path);
    try {
      const size = fs.statSync(full).size;
      if (size > BIG_BYTES) { exclude.push({ path: f.path, reason: 'big', size }); continue; }
    } catch { continue; /* gone already */ }
    if (hasToken(full)) exclude.push({ path: f.path, reason: 'secret' });
  }
  return { exclude };
}

// Add paths to .gitignore (used when the user says "yes, keep these out for good").
function ignoreForever(root, paths) {
  const gi = path.join(root, '.gitignore');
  let text = '';
  try { text = fs.readFileSync(gi, 'utf8'); } catch { /* new file */ }
  const lines = new Set(text.split('\n').map((l) => l.trim()));
  const add = paths.map((p) => `/${p.replace(/^\/+/, '')}`).filter((p) => !lines.has(p));
  if (!add.length) return 0;
  const sep = text && !text.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(gi, `${text}${sep}# Kept out by Twig\n${add.join('\n')}\n`);
  return add.length;
}

module.exports = { review, isSecretName, hasToken, ignoreForever, BIG_BYTES };
