'use strict';
// Follows Claude Code session logs (~/.claude/projects/<slug>/<session>.jsonl) by tailing new bytes.
// Log content is untrusted: paths are validated and only ever used for matching, never executed.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const GIT_CMD = /(?:^|[;&|(\s])git\s+(?:-C\s+\S+\s+)?(commit|push|pull|merge|rebase|reset|checkout|switch|stash|revert|restore|branch|tag|cherry-pick|init|clone)\b/;
const FIRST_READ_MAX = 512 * 1024;
const RECENT_MS = 24 * 3600 * 1000;

function validPath(p) {
  return typeof p === 'string' && p.length > 1 && p.length <= 4096 && path.isAbsolute(p) && !p.includes('\0') && !p.startsWith('-')
    ? path.normalize(p) : null;
}

function isInside(file, root) {
  const rel = path.relative(root, file);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

class ClaudeWatcher extends EventEmitter {
  constructor({ dir, quietMs = 60000, busyMs = 20000, activeMs = 5 * 60000, now = () => Date.now() } = {}) {
    super();
    this.dir = dir;
    this.quietMs = quietMs;
    this.busyMs = busyMs;
    this.activeMs = activeMs;
    this.now = now;
    this.files = new Map(); // file -> { offset, partial }
    this.sessions = new Map();
    this.timer = null;
  }

  start(intervalMs = 3000) {
    this.scan();
    this.timer = setInterval(() => { try { this.scan(); } catch (e) { this.emit('error', e); } }, intervalMs);
    return this;
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  _logFiles() {
    const out = [];
    let dirs = [];
    try { dirs = fs.readdirSync(this.dir, { withFileTypes: true }); } catch { return out; }
    const cutoff = this.now() - RECENT_MS;
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const sub = path.join(this.dir, d.name);
      let entries = [];
      try { entries = fs.readdirSync(sub); } catch { continue; }
      for (const name of entries) {
        if (!name.endsWith('.jsonl')) continue;
        const file = path.join(sub, name);
        try {
          const st = fs.statSync(file);
          if (st.isFile() && st.mtimeMs >= cutoff) out.push({ file, size: st.size, mtimeMs: st.mtimeMs });
        } catch { /* vanished */ }
      }
    }
    return out;
  }

  scan() {
    for (const { file, size, mtimeMs } of this._logFiles()) {
      let rec = this.files.get(file);
      const first = !rec;
      if (!rec) {
        rec = { offset: Math.max(0, size - FIRST_READ_MAX), partial: '', skipFirst: size > FIRST_READ_MAX };
        this.files.set(file, rec);
      }
      if (size < rec.offset) { rec.offset = 0; rec.partial = ''; } // truncated/rotated
      if (size === rec.offset) continue;
      const chunk = this._read(file, rec.offset, size);
      rec.offset = size;
      let text = rec.partial + chunk;
      if (rec.skipFirst) {
        const nl = text.indexOf('\n');
        text = nl === -1 ? '' : text.slice(nl + 1);
        rec.skipFirst = nl === -1;
      }
      const lines = text.split('\n');
      rec.partial = lines.pop();
      for (const line of lines) this._line(line, file, mtimeMs, first);
    }
    this._checkQuiet();
  }

  _read(file, from, to) {
    const fd = fs.openSync(file, 'r');
    try {
      const len = Math.min(to - from, 8 * 1024 * 1024);
      const buf = Buffer.alloc(len);
      const n = fs.readSync(fd, buf, 0, len, from);
      return buf.subarray(0, n).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  }

  _line(line, file, fallbackTime, silent) {
    if (!line.trim()) return;
    let obj;
    try { obj = JSON.parse(line); } catch { return; }
    if (!obj || typeof obj !== 'object') return;
    const id = typeof obj.sessionId === 'string' && obj.sessionId.length < 200 ? obj.sessionId : path.basename(file, '.jsonl');
    let s = this.sessions.get(id);
    if (!s) {
      s = { id, file, cwd: null, branch: null, title: null, lastActivity: 0, lastEdit: 0, edited: new Set(), pending: new Set(), gitCommands: [] };
      this.sessions.set(id, s);
    }
    const cwd = validPath(obj.cwd);
    if (cwd) s.cwd = cwd;
    if (typeof obj.gitBranch === 'string' && obj.gitBranch.length < 256) s.branch = obj.gitBranch;
    if (typeof obj.slug === 'string' && obj.slug.length < 200) s.title = obj.slug;
    const t = Date.parse(obj.timestamp);
    const time = Number.isFinite(t) ? t : fallbackTime;
    if (obj.type === 'user' || obj.type === 'assistant') s.lastActivity = Math.max(s.lastActivity, time);

    const content = obj.type === 'assistant' && obj.message && Array.isArray(obj.message.content) ? obj.message.content : [];
    for (const block of content) {
      if (!block || block.type !== 'tool_use' || !block.input || typeof block.input !== 'object') continue;
      if (EDIT_TOOLS.has(block.name)) {
        const fp = validPath(block.input.file_path || block.input.notebook_path);
        if (!fp) continue;
        s.edited.add(fp);
        s.lastEdit = Math.max(s.lastEdit, time);
        if (!silent) {
          s.pending.add(fp);
          this.emit('edit', { session: this.describe(s), file: fp });
        }
      } else if (block.name === 'Bash' && typeof block.input.command === 'string') {
        const m = GIT_CMD.exec(block.input.command.slice(0, 4000));
        if (m) {
          const ev = { verb: m[1], command: block.input.command.slice(0, 300), time };
          s.gitCommands.push(ev);
          if (s.gitCommands.length > 20) s.gitCommands.shift();
          if (!silent) this.emit('git', { session: this.describe(s), ...ev });
        }
      }
    }
  }

  _checkQuiet() {
    const now = this.now();
    for (const s of this.sessions.values()) {
      if (s.pending.size && now - Math.max(s.lastActivity, s.lastEdit) >= this.quietMs) {
        const files = [...s.pending];
        s.pending.clear();
        this.emit('quiet', { session: this.describe(s), files });
      }
    }
  }

  describe(s) {
    const now = this.now();
    return {
      id: s.id,
      cwd: s.cwd,
      branch: s.branch,
      title: s.title,
      lastActivity: s.lastActivity,
      active: now - s.lastActivity < this.activeMs,
      editedCount: s.edited.size,
      pendingCount: s.pending.size,
      gitCommands: s.gitCommands.slice(-5),
    };
  }

  list() {
    return [...this.sessions.values()].filter((s) => s.lastActivity).map((s) => this.describe(s)).sort((a, b) => b.lastActivity - a.lastActivity);
  }

  // Is Claude changing things under this folder right now?
  isBusy(root) {
    const now = this.now();
    for (const s of this.sessions.values()) {
      if (now - Math.max(s.lastActivity, s.lastEdit) > this.busyMs) continue;
      if (s.cwd && isInside(s.cwd, root)) return true;
      if (now - s.lastEdit <= this.busyMs) for (const f of s.pending) if (isInside(f, root)) return true;
    }
    return false;
  }

  // Folders Claude has worked in (candidates for project discovery).
  folders() {
    const set = new Set();
    for (const s of this.sessions.values()) if (s.cwd) set.add(s.cwd);
    return [...set];
  }
}

module.exports = { ClaudeWatcher, validPath, isInside, GIT_CMD };
