'use strict';
// Tiny JSON store: atomic writes, schema version, corrupt-file recovery.
const fs = require('fs');
const path = require('path');

const SCHEMA = 1;

function defaults() {
  return {
    schema: SCHEMA,
    user: { name: '', email: '', onboarded: false },
    projects: [], // { id, path, name, addedAt }
    mascot: { xp: 0, firsts: {}, saveTimes: [] },
    lessons: { seen: {}, seenAt: {} }, // id -> times shown / last shown
    settings: {
      ai: true,
      autoSaveAfterClaude: false,
      notifications: true,
      showCommands: false,
      startAtLogin: false,
    },
    ignoredSuggestions: [],
  };
}

function merge(base, extra) {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(extra)) {
    if (base[k] && typeof base[k] === 'object' && !Array.isArray(base[k]) && v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = merge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'state.json');
    fs.mkdirSync(dir, { recursive: true });
    this.data = this._load();
  }

  _load() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch {
      return defaults();
    }
    try {
      return merge(defaults(), JSON.parse(raw));
    } catch {
      // Keep the broken file for inspection, start fresh.
      try { fs.renameSync(this.file, `${this.file}.broken-${Date.now()}`); } catch { /* ignore */ }
      return defaults();
    }
  }

  save() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  update(fn) {
    fn(this.data);
    this.save();
    return this.data;
  }
}

module.exports = { Store, defaults, SCHEMA };
