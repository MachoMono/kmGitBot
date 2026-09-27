'use strict';
// Electron main process: owns all git/file access. The window only ever sends project ids.
const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, Notification, nativeImage } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { Store } = require('./core/store');
const git = require('./core/git');
const { safeRepoPath } = require('./core/gitRunner');
const explain = require('./core/explain');
const guardian = require('./core/guardian');
const mascot = require('./core/mascot');
const lessons = require('./core/lessons');
const ai = require('./core/ai');
const { ClaudeWatcher, isInside } = require('./core/claudeWatcher');

const E2E = process.env.KMGIT_E2E === '1';
if (process.env.KMGIT_HOME) app.setPath('userData', process.env.KMGIT_HOME);
app.setName('Twig');

const CLAUDE_DIR = process.env.KMGIT_CLAUDE_DIR || path.join(os.homedir(), '.claude', 'projects');
const DISCOVER_DIRS = (process.env.KMGIT_DISCOVER_DIRS || path.join(os.homedir(), 'aiProjects')).split(path.delimiter).filter(Boolean);
const QUIET_MS = Number(process.env.KMGIT_QUIET_MS) || 60000;
const ICON = path.join(__dirname, '..', 'assets', 'icon.png');

let store;
let win = null;
let tray = null;
let watcher;
let quitting = false;
const statusCache = new Map(); // projectId -> { status, summary }
const discovered = new Map(); // token -> path
const lastNotified = new Map();
const dirtySince = new Map();

if (!E2E && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(boot);
}

// ---------- helpers ----------
const projectById = (id) => store.data.projects.find((p) => p.id === id);

function requireProject(id) {
  const p = projectById(id);
  if (!p) throw new Error('Unknown project');
  const real = safeRepoPath(p.path);
  if (!real) throw Object.assign(new Error('missing'), { friendly: { key: 'missing', title: 'I can’t find that folder', body: `It may have been moved or renamed. It used to be at ${p.path}.`, fix: 'remove' } });
  return { ...p, path: real };
}

function identity() {
  const u = store.data.user;
  return { name: u.name || 'Twig User', email: u.email || `${(u.name || 'twig').toLowerCase().replace(/[^a-z0-9]+/g, '.')}@users.noreply.localhost` };
}

function addProjectPath(p) {
  const real = safeRepoPath(p);
  if (!real) return null;
  const existing = store.data.projects.find((x) => x.path === real);
  if (existing) return existing;
  const proj = { id: crypto.randomUUID(), path: real, name: path.basename(real), addedAt: Date.now() };
  store.update((d) => d.projects.push(proj));
  return proj;
}

function award(action) {
  let res;
  store.update((d) => { res = mascot.award(d.mascot, action); });
  if (res.levelUp) tray && tray.setToolTip(`Twig — level ${res.level} ${res.stage.name}`);
  return res;
}

function lessonFor(event) {
  const l = lessons.forEvent(event, store.data.lessons.seen, store.data.lessons.seenAt);
  if (!l) return null;
  store.update((d) => {
    d.lessons.seen[l.id] = (d.lessons.seen[l.id] || 0) + 1;
    d.lessons.seenAt[l.id] = Date.now();
  });
  return l;
}

function claudeFor(root) {
  const sessions = watcher.list().filter((s) => s.cwd && (isInside(s.cwd, root) || isInside(root, s.cwd)));
  return { active: sessions.some((s) => s.active), busy: watcher.isBusy(root), sessions: sessions.slice(0, 5) };
}

async function refreshProject(p) {
  const real = safeRepoPath(p.path);
  let status;
  if (!real) status = { isRepo: false, missing: true };
  else {
    try { status = await git.status(real); } catch (e) { status = { isRepo: false, error: String(e.message) }; }
  }
  const summary = status.missing ? { state: 'help', icon: '🔍', label: 'Folder not found', detail: 'It may have moved' } : explain.summarizeStatus(status);
  if (status.files && status.files.length) {
    if (!dirtySince.has(p.id)) dirtySince.set(p.id, Date.now());
  } else dirtySince.delete(p.id);
  const entry = { status, summary, claude: real ? claudeFor(real) : { active: false, busy: false, sessions: [] } };
  statusCache.set(p.id, entry);
  return entry;
}

async function refreshAll() {
  await Promise.all(store.data.projects.map(refreshProject));
  checkLongUnsaved();
  pushState();
}

function publicState() {
  return {
    user: store.data.user,
    settings: store.data.settings,
    mascot: mascot.snapshot(store.data.mascot),
    firsts: store.data.mascot.firsts,
    lessonsSeen: store.data.lessons.seen,
    projects: store.data.projects.map((p) => {
      const c = statusCache.get(p.id) || {};
      const st = c.status || {};
      return {
        id: p.id, name: p.name, path: p.path,
        summary: c.summary || { state: 'loading', icon: '⏳', label: 'Checking…', detail: '' },
        files: (st.files || []).slice(0, 200).map((f) => ({ path: f.path, kind: f.kind, from: f.from })),
        fileCount: (st.files || []).length,
        branch: st.branch, ahead: st.ahead || 0, behind: st.behind || 0,
        isRepo: !!st.isRepo, hasCommits: !!st.hasCommits, hasRemote: !!st.hasRemote, upstream: st.upstream || null,
        needsHelp: st.needsHelp ? explain.HELP[st.needsHelp] : null,
        claude: c.claude || { active: false, busy: false, sessions: [] },
      };
    }),
    claudeSessions: watcher ? watcher.list().slice(0, 12) : [],
  };
}

let lastSent = '';
function pushState(force) {
  if (!win || win.isDestroyed()) return;
  const s = publicState();
  const json = JSON.stringify(s);
  if (!force && json === lastSent) return;
  lastSent = json;
  win.webContents.send('state', s);
}

function say(payload) {
  if (win && !win.isDestroyed()) win.webContents.send('twig', payload);
}

function notify(key, title, body) {
  if (!store.data.settings.notifications || E2E || !Notification.isSupported()) return;
  const last = lastNotified.get(key) || 0;
  if (Date.now() - last < 30 * 60 * 1000) return;
  lastNotified.set(key, Date.now());
  const n = new Notification({ title, body, icon: ICON, silent: false });
  n.on('click', () => showWindow());
  n.show();
}

function checkLongUnsaved() {
  for (const [id, since] of dirtySince) {
    if (Date.now() - since > 2 * 3600 * 1000) {
      const p = projectById(id);
      if (p) notify(`dirty:${id}`, 'Twig 🌱', `You have unsaved changes in ${p.name} from a while ago. Want to make a save point?`);
    }
  }
}

function makeMessageFn() {
  if (!store.data.settings.ai || process.env.KMGIT_NO_AI === '1') return undefined;
  return (files, diff) => ai.commitMessage(files, diff, { cwd: app.getPath('temp') });
}

// Wraps every action: friendly errors, XP, lessons.
function action(name, fn) {
  ipcMain.handle(name, async (_e, ...args) => {
    try {
      const out = await fn(...args);
      refreshAll().catch(() => {});
      return out;
    } catch (e) {
      return { ok: false, problem: e.friendly || explain.fromGitError(e) };
    }
  });
}

function finish(res, event, extra = {}) {
  if (!res.ok) return { ok: false, result: res, problem: explain.fromResult(res) };
  const out = { ok: true, result: res, ...extra };
  if (event && !res.nothing && !res.upToDate) {
    out.award = award(event);
    out.lesson = lessonFor(event);
    if (out.award.levelUp) out.levelLesson = lessonFor(`level:${out.award.level}`);
  }
  return out;
}

// ---------- IPC ----------
function registerIpc() {
  ipcMain.handle('getState', () => publicState());

  ipcMain.handle('onboard', (_e, { name, email }) => {
    store.update((d) => {
      d.user.name = String(name || '').trim().slice(0, 80);
      d.user.email = String(email || '').trim().slice(0, 120);
      d.user.onboarded = true;
    });
    pushState(true);
    return { ok: true };
  });

  ipcMain.handle('discover', async () => {
    const found = new Set();
    for (const base of DISCOVER_DIRS) {
      let entries = [];
      try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.')) found.add(path.join(base, e.name));
    }
    for (const f of watcher.folders()) found.add(f);
    const have = new Set(store.data.projects.map((p) => p.path));
    discovered.clear();
    const out = [];
    for (const f of found) {
      const real = safeRepoPath(f);
      if (!real || have.has(real) || real === os.homedir()) continue;
      const token = crypto.randomUUID();
      discovered.set(token, real);
      out.push({ token, name: path.basename(real), path: real, isRepo: await git.isRepo(real), claude: watcher.folders().includes(f) });
    }
    return out.sort((a, b) => (b.claude - a.claude) || (b.isRepo - a.isRepo) || a.name.localeCompare(b.name));
  });

  ipcMain.handle('addDiscovered', async (_e, tokens) => {
    const added = [];
    for (const t of [].concat(tokens || [])) {
      const p = discovered.get(t);
      if (p) { const proj = addProjectPath(p); if (proj) added.push(proj.id); }
    }
    await refreshAll();
    return { ok: true, added };
  });

  ipcMain.handle('pickFolder', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Pick a project folder', properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
    const proj = addProjectPath(r.filePaths[0]);
    await refreshAll();
    return proj ? { ok: true, id: proj.id } : { ok: false };
  });

  ipcMain.handle('removeProject', (_e, id) => {
    store.update((d) => { d.projects = d.projects.filter((p) => p.id !== id); });
    statusCache.delete(id);
    pushState(true);
    return { ok: true };
  });

  ipcMain.handle('history', async (_e, id) => {
    try {
      const p = requireProject(id);
      const list = await git.history(p.path, 100);
      return { ok: true, history: list, lesson: list.length ? lessonFor('history') : null };
    } catch (e) {
      return { ok: false, problem: e.friendly || explain.fromGitError(e) };
    }
  });

  ipcMain.handle('changesIn', async (_e, id, hash) => {
    try {
      return { ok: true, files: await git.changesIn(requireProject(id).path, hash) };
    } catch (e) {
      return { ok: false, problem: e.friendly || explain.fromGitError(e) };
    }
  });

  ipcMain.handle('explainSavePoint', async (_e, id, hash) => {
    if (!store.data.settings.ai || process.env.KMGIT_NO_AI === '1') return { ok: false, off: true };
    try {
      const p = requireProject(id);
      const files = await git.changesIn(p.path, hash);
      const { rawGit } = require('./core/gitRunner');
      const subject = (await rawGit(p.path, ['log', '-1', '--format=%s', hash])).trim();
      const diff = (await rawGit(p.path, ['show', '--no-color', '--format=', '--stat', '--patch', hash])).slice(0, 6000);
      return { ok: true, text: await ai.explainSavePoint({ subject, files, diff }, { cwd: app.getPath('temp'), timeout: 60000 }) };
    } catch {
      return { ok: false };
    }
  });

  action('init', async (id) => {
    const p = requireProject(id);
    const r = await git.init(p.path);
    if (!r.ok || r.already) return finish(r, null);
    return finish(r, 'init');
  });

  action('save', async (id, opts = {}) => {
    const p = requireProject(id);
    if (!opts.anyway && watcher.isBusy(p.path)) return { ok: false, problem: explain.REASONS['claude-busy'] };
    const r = await git.save(p.path, { message: typeof opts.message === 'string' ? opts.message.slice(0, 500) : '', identity: identity(), makeMessage: makeMessageFn() });
    const out = finish(r, 'save');
    if (r.ok && r.excluded && r.excluded.length) out.excludedLesson = lessonFor('excluded');
    return out;
  });

  action('ignoreForever', async (id, paths) => {
    const p = requireProject(id);
    const safe = [].concat(paths || []).filter((x) => typeof x === 'string' && !x.startsWith('-') && !path.isAbsolute(x) && !x.split(/[\\/]/).includes('..'));
    return { ok: true, added: guardian.ignoreForever(p.path, safe) };
  });

  action('push', async (id) => {
    const p = requireProject(id);
    const r = await git.push(p.path);
    if (!r.ok && r.reason === 'needs-remote') {
      const gh = await git.githubStatus();
      return { ...finish(r), github: gh };
    }
    return finish(r, 'push');
  });

  action('pull', async (id) => finish(await git.pull(requireProject(id).path, { identity: identity() }), 'pull'));
  action('undo', async (id, hash) => finish(await git.undo(requireProject(id).path, hash, { identity: identity() }), 'undo'));
  action('restore', async (id, hash, file) => finish(await git.restoreFile(requireProject(id).path, hash, file), 'restore'));
  action('rescue', async (id) => finish(await git.rescue(requireProject(id).path, { identity: identity() }), 'rescue'));
  action('githubStatus', async () => ({ ok: true, ...(await git.githubStatus()) }));
  action('githubHome', async (id) => finish(await git.createGithubHome(requireProject(id).path), 'githubHome'));

  ipcMain.handle('lessonRead', (_e, lessonId) => {
    if (!lessons.LESSONS.some((l) => l.id === lessonId)) return { ok: false };
    const key = `read:${lessonId}`;
    if (store.data.lessons.seen[key]) return { ok: true };
    store.update((d) => { d.lessons.seen[key] = 1; });
    const res = award('lesson');
    pushState(true);
    return { ok: true, award: res };
  });

  ipcMain.handle('lessons', () => lessons.LESSONS);

  ipcMain.handle('resetTips', () => {
    store.update((d) => { for (const k of Object.keys(d.lessons.seen)) if (!k.startsWith('read:')) delete d.lessons.seen[k]; });
    return { ok: true };
  });

  ipcMain.handle('setSettings', (_e, partial) => {
    const allowed = ['ai', 'autoSaveAfterClaude', 'notifications', 'showCommands', 'startAtLogin'];
    store.update((d) => {
      for (const k of allowed) if (typeof partial[k] === 'boolean') d.settings[k] = partial[k];
      if (typeof partial.name === 'string') d.user.name = partial.name.trim().slice(0, 80);
      if (typeof partial.email === 'string') d.user.email = partial.email.trim().slice(0, 120);
    });
    if (typeof partial.startAtLogin === 'boolean') setAutostart(partial.startAtLogin);
    pushState(true);
    return { ok: true };
  });

  ipcMain.handle('openFolder', (_e, id) => {
    const p = projectById(id);
    if (p && safeRepoPath(p.path)) shell.openPath(p.path);
    return { ok: true };
  });

  ipcMain.handle('refresh', async () => { await refreshAll(); return publicState(); });
}

// ---------- Claude watching ----------
const GIT_VERB_WORDS = {
  commit: 'made a save point', push: 'sent save points to GitHub', pull: 'got the latest from GitHub',
  merge: 'combined two lines of work', rebase: 'reshuffled save points', reset: 'moved back in time',
  checkout: 'switched what the folder shows', switch: 'switched to another line of work', stash: 'put changes on the backup shelf',
  revert: 'undid a save point', restore: 'brought a file back', branch: 'worked with lines of work (branches)',
  tag: 'put a label on a save point', 'cherry-pick': 'copied a save point', init: 'started watching a folder', clone: 'copied a project from online',
};

function projectForPath(file) {
  return store.data.projects.find((p) => isInside(file, p.path));
}

function startWatcher() {
  watcher = new ClaudeWatcher({ dir: CLAUDE_DIR, quietMs: QUIET_MS });
  watcher.on('edit', () => pushState());
  watcher.on('git', (ev) => {
    const p = ev.session.cwd && projectForPath(ev.session.cwd);
    if (!p) return;
    say({ kind: 'claude-git', projectId: p.id, text: `Claude just ${GIT_VERB_WORDS[ev.verb] || `used git ${ev.verb}`} in ${p.name}.`, word: ev.verb, command: ev.command });
  });
  watcher.on('quiet', async ({ files }) => {
    const byProject = new Map();
    for (const f of files) {
      const p = projectForPath(f);
      if (p) byProject.set(p.id, (byProject.get(p.id) || 0) + 1);
    }
    for (const [id, count] of byProject) {
      const p = projectById(id);
      const entry = await refreshProject(p);
      if (!entry.status.files || !entry.status.files.length) continue;
      if (store.data.settings.autoSaveAfterClaude) {
        try {
          const r = await git.save(requireProject(id).path, { identity: identity(), makeMessage: makeMessageFn() });
          if (r.ok && !r.nothing) {
            const res = award('save');
            say({ kind: 'auto-saved', projectId: id, text: `Claude finished in ${p.name}, so I made a save point: “${r.message}”. You can undo it any time.`, award: res });
            notify(`quiet:${id}`, 'Twig saved Claude’s work 🌱', `${p.name}: “${r.message}”`);
          }
        } catch { /* show as normal nudge below on next refresh */ }
      } else {
        say({ kind: 'claude-quiet', projectId: id, count, text: `Claude changed ${count} file${count === 1 ? '' : 's'} in ${p.name}. Want a save point, so you can undo if you don’t like it?`, lesson: lessonFor('claude-quiet') });
        notify(`quiet:${id}`, 'Claude finished changing files', `${count} file${count === 1 ? '' : 's'} changed in ${p.name}. Tap to make a save point.`);
      }
    }
    refreshAll().catch(() => {});
  });
  watcher.on('error', () => {});
  watcher.start(Number(process.env.KMGIT_SCAN_MS) || 3000);
}

// ---------- window, tray, autostart ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1120, height: 780, minWidth: 860, minHeight: 600,
    title: 'Twig', icon: ICON, backgroundColor: '#fbf6ec', show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  win.once('ready-to-show', () => { if (!process.argv.includes('--hidden')) win.show(); });
  win.on('close', (e) => {
    if (!quitting && tray && !E2E) { e.preventDefault(); win.hide(); }
  });
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow();
  win.show();
  win.focus();
}

function createTray() {
  if (E2E) return;
  try {
    tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 22, height: 22 }));
    tray.setToolTip('Twig — your git buddy');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open Twig', click: showWindow },
      { type: 'separator' },
      { label: 'Quit', click: () => { quitting = true; app.quit(); } },
    ]));
    tray.on('click', showWindow);
  } catch { tray = null; }
}

function setAutostart(on) {
  const file = path.join(os.homedir(), '.config', 'autostart', 'kmgitbot.desktop');
  if (!on) { try { fs.unlinkSync(file); } catch { /* not there */ } return; }
  const root = path.join(__dirname, '..');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `[Desktop Entry]\nType=Application\nName=Twig\nComment=Your friendly git buddy\nExec="${path.join(root, 'scripts', 'twig')}" --hidden\nIcon=${ICON}\nX-GNOME-Autostart-enabled=true\n`);
}

async function boot() {
  store = new Store(app.getPath('userData'));
  startWatcher();
  registerIpc();
  createWindow();
  createTray();
  await refreshAll();
  const tick = () => refreshAll().catch(() => {});
  setInterval(() => { if (win && !win.isDestroyed() && win.isVisible()) tick(); }, Number(process.env.KMGIT_POLL_MS) || 5000);
  setInterval(tick, 20000);
}

app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => { if (!tray || E2E) app.quit(); });
