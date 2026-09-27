'use strict';
// Optional AI help via the user's logged-in `claude` CLI. Everything has a non-AI fallback.
// Model ceiling is enforced here: only Haiku and Sonnet may ever be called from the app.
const { spawn } = require('child_process');

const MODELS = Object.freeze({
  commitMessage: 'haiku', // Haiku 4.5: fast and cheap for a one-line summary
  explain: 'sonnet', // Sonnet 5: gentler, clearer teaching, only on demand
});
const ALLOWED = new Set(['haiku', 'sonnet']);

function assertModel(model) {
  if (!ALLOWED.has(model)) throw new Error(`Model "${model}" is not allowed in kmGitBot (Haiku or Sonnet only)`);
}

// No built-in tools, no MCP connectors, no skills: the helper can only return text.
// (Verified: the CLI's init event reports tools: [] and mcp_servers: [] with these flags.)
const ARGS = (model) => ['-p', '--model', model, '--no-session-persistence', '--tools', '', '--strict-mcp-config',
  '--mcp-config', '{"mcpServers":{}}', '--disable-slash-commands', '--output-format', 'text'];

function ask(model, prompt, { bin = process.env.KMGIT_CLAUDE_BIN || 'claude', cwd, timeout = 25000 } = {}) {
  try { assertModel(model); } catch (e) { return Promise.reject(e); }
  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    let done = false;
    const child = spawn(bin, ARGS(model), {
      cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env },
    });
    const finish = (fn, v) => { if (!done) { done = true; clearTimeout(timer); fn(v); } };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(reject, new Error('AI timed out')); }, timeout);
    child.stdout.on('data', (d) => { out += d; if (out.length > 100000) child.kill('SIGKILL'); });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => finish(reject, e));
    child.on('close', (code) => (code === 0 ? finish(resolve, out.trim()) : finish(reject, new Error(`claude exited ${code}: ${err.slice(0, 300)}`))));
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}

function cleanMessage(text) {
  const line = String(text || '').split('\n').map((l) => l.trim()).find((l) => l) || '';
  const cleaned = line.replace(/^(commit message:|message:)\s*/i, '').replace(/^["'`]+|["'`]+$/g, '').replace(/\.$/, '').trim();
  return cleaned.length > 72 ? `${cleaned.slice(0, 69).trimEnd()}...` : cleaned;
}

async function commitMessage(files, diff, opts) {
  const list = files.slice(0, 30).map((f) => `${f.kind}: ${f.path}`).join('\n');
  const prompt = `Write a git commit message for the change below.
Rules: one line, at most 60 characters, imperative mood ("Add", "Fix", "Update"), plain words, no quotes, no trailing period.
Reply with only the message.

Files:
${list}

Diff (may be cut short):
${diff}`;
  return cleanMessage(await ask(MODELS.commitMessage, prompt, opts));
}

async function explainSavePoint({ subject, files, diff }, opts) {
  const prompt = `You are Twig, a friendly little sprout who helps people who have never used git.
Explain what this save point changed in 2-3 short, warm sentences a non-programmer understands. No jargon, no code, no markdown.

Save point title: ${subject}
Files: ${files.map((f) => `${f.kind} ${f.path}`).join(', ').slice(0, 2000)}
Diff (may be cut short):
${String(diff).slice(0, 6000)}`;
  return (await ask(MODELS.explain, prompt, opts)).slice(0, 1200);
}

module.exports = { ARGS, ask, commitMessage, explainSavePoint, cleanMessage, assertModel, MODELS, ALLOWED };
