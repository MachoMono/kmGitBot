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
];

function isSecretName(file) {
  const base = path.basename(file);
  if (SAFE_ENV.has(base)) return false;
  return SECRET_PATTERNS.some((re) => re.test(base));
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
    try {
      const size = fs.statSync(path.join(root, f.path)).size;
      if (size > BIG_BYTES) exclude.push({ path: f.path, reason: 'big', size });
    } catch { /* gone already */ }
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

module.exports = { review, isSecretName, ignoreForever, BIG_BYTES };
