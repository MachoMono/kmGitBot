'use strict';
/* global Twig */
(() => {
  const api = window.kmgit;
  const $app = document.getElementById('app');
  const $modal = document.getElementById('modal-root');
  const $toasts = document.getElementById('toasts');

  const S = {
    state: null,
    view: 'home',
    projectId: null,
    tab: 'changes',
    history: {}, // projectId -> list
    expanded: null,
    changes: {}, // hash -> files
    explained: {}, // hash -> text
    busy: null,
    note: '',
    showNote: false,
    speech: null, // { projectId, title, text, mood, actions:[{label, fix, primary}] , at }
    proudUntil: 0,
    onboard: { step: 0, name: '', email: '', found: null, picked: new Set() },
    modals: [],
    lessons: null,
  };

  // ---------- utils ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  function ago(t) {
    const s = Math.max(0, (Date.now() - new Date(t).getTime()) / 1000);
    if (s < 45) return 'just now';
    if (s < 3600) return `${plural(Math.round(s / 60), 'minute')} ago`;
    if (s < 86400) return `${plural(Math.round(s / 3600), 'hour')} ago`;
    if (s < 172800) return 'yesterday';
    if (s < 30 * 86400) return `${Math.round(s / 86400)} days ago`;
    return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }
  const KIND = { new: ['✨', 'new file'], edited: ['✏️', 'edited'], deleted: ['🗑️', 'deleted'], renamed: ['🏷️', 'renamed'], conflict: ['⚠️', 'needs a decision'] };
  const project = () => S.state && S.state.projects.find((p) => p.id === S.projectId);
  const firstName = () => ((S.state && S.state.user.name) || '').split(' ')[0];

  let lastXp = null; // { el, total, at } — several rewards at once become one "+N XP"
  function xpToast(n) {
    if (lastXp && lastXp.el.isConnected && Date.now() - lastXp.at < 2500) {
      lastXp.total += n;
      lastXp.at = Date.now();
      lastXp.el.textContent = `+${lastXp.total} XP`;
      return;
    }
    lastXp = { el: toast(`+${n} XP`, 'xp'), total: n, at: Date.now() };
  }

  function toast(text, cls = '') {
    const el = document.createElement('div');
    el.className = `toast ${cls}`;
    el.textContent = text;
    $toasts.appendChild(el);
    setTimeout(() => el.remove(), 3800);
    return el;
  }

  // ---------- mood & voice ----------
  function globalMood() {
    const st = S.state;
    if (!st) return 'happy';
    if (Date.now() < S.proudUntil) return 'proud';
    if (st.projects.some((p) => p.needsHelp)) return 'worried';
    if (st.claudeSessions.some((s) => s.active)) return 'curious';
    const h = new Date().getHours();
    if ((h >= 23 || h < 6) && st.projects.every((p) => !p.fileCount)) return 'sleepy';
    return 'happy';
  }

  function projectMood(p) {
    if (Date.now() < S.proudUntil) return 'proud';
    if (p.needsHelp || p.summary.state === 'help') return 'worried';
    if (p.claude.active) return 'curious';
    return 'happy';
  }

  function greeting() {
    const h = new Date().getHours();
    const part = h < 5 ? 'Hello, night owl' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
    return firstName() ? `${part}, ${firstName()}!` : `${part}!`;
  }

  function homeSpeech() {
    const ps = S.state.projects;
    if (!ps.length) return { title: greeting(), text: 'Let’s add your first project. I’ll keep save points so you never lose work.', actions: [{ label: '➕ Add a project', fix: 'add', primary: true }] };
    const help = ps.filter((p) => p.needsHelp || p.summary.state === 'help');
    const unsaved = ps.filter((p) => p.fileCount);
    const ahead = ps.filter((p) => p.summary.state === 'ahead' || p.summary.state === 'local');
    const claude = S.state.claudeSessions.filter((s) => s.active);
    if (help.length) return { title: greeting(), text: `${help[0].name} needs a hand. Tap it and I’ll walk you through it — nothing is lost.` };
    if (unsaved.length) return { title: greeting(), text: `${plural(unsaved.length, 'project')} ${unsaved.length === 1 ? 'has' : 'have'} unsaved changes${claude.length ? ', and Claude is busy too' : ''}. Pick one and I’ll help you make a save point.` };
    if (ahead.length) return { title: greeting(), text: `Everything is saved. ${plural(ahead.length, 'project')} could use a backup online.` };
    return { title: greeting(), text: 'Everything is saved and backed up. Go make something wonderful — I’ll keep watch. 🌱' };
  }

  function projectSpeech(p) {
    const s = p.summary.state;
    if (p.needsHelp) return { title: p.needsHelp.title, text: p.needsHelp.body, mood: 'worried', actions: [{ label: '🩹 Fix it for me', fix: 'rescue', primary: true }] };
    if (s === 'help') return { title: 'I can’t find this folder', text: `It may have been moved or renamed. It used to be at ${p.path}.`, mood: 'worried', actions: [{ label: 'Stop watching it', fix: 'remove' }] };
    if (s === 'untracked') return { title: 'I’m not watching this folder yet', text: 'Want me to start? I’ll keep save points, so you can always go back in time.' };
    if (s === 'unsaved') {
      if (p.claude.busy) return { title: 'Claude is busy here', text: 'Claude is changing files right now. I’ll wait until it pauses before saving, so nothing gets saved half-finished.', mood: 'curious' };
      return { title: `${plural(p.fileCount, 'change')} since your last save point`, text: 'Tap “Save my work” and I’ll take a snapshot of this project, so you can always come back to this moment.' };
    }
    if (s === 'empty') return { title: 'Ready for the first save point', text: 'Make a change in this folder and I’ll help you save it.' };
    if (s === 'local') return { title: 'Saved on this computer', text: 'Back it up online so it’s safe even if something happens to this computer.' };
    if (s === 'ahead') return { title: 'Saved, but only here', text: `${p.summary.detail}. Want to back ${p.ahead === 1 ? 'it' : 'them'} up?` };
    if (s === 'behind') return { title: 'GitHub has newer work', text: 'Tap “Get the latest” to bring it onto this computer.' };
    return { title: 'All saved and backed up', text: 'Nothing to do here. Nice work! 🌿' };
  }

  function currentSpeech(scopeId) {
    if (S.speech && (S.speech.projectId == null || S.speech.projectId === scopeId) && Date.now() - S.speech.at < 90000) return S.speech;
    return null;
  }

  function sayNow(sp) {
    S.speech = { at: Date.now(), projectId: S.view === 'project' ? S.projectId : null, ...sp };
    render();
  }

  // ---------- rendering ----------
  function bubble(sp, mood) {
    const acts = (sp.actions || []).map((a, i) => `<button class="btn ${a.primary ? 'primary' : ''} small" data-fix="${esc(a.fix)}" data-i="${i}">${esc(a.label)}</button>`).join('');
    return `<div class="bubble ${mood}" data-testid="bubble">
      ${sp.title ? `<div class="say-title">${esc(sp.title)}</div>` : ''}
      <p>${esc(sp.text)}</p>
      ${acts ? `<div class="row actions">${acts}</div>` : ''}
    </div>`;
  }

  function hero(sp, mood, size = 150) {
    const m = S.state.mascot;
    return `<div class="hero">${Twig.svg({ stage: m.stage.id, mood: sp.mood || mood, size })}${bubble(sp, sp.mood || mood)}</div>`;
  }

  function sidebar() {
    const st = S.state;
    const m = st.mascot;
    const nav = st.projects.map((p) => `
      <button class="nav-item ${S.view === 'project' && S.projectId === p.id ? 'active' : ''}" data-go="project" data-id="${p.id}" data-testid="nav-project">
        <span class="ic" aria-hidden="true">${p.summary.icon}</span>
        <span class="txt"><div class="nm">${esc(p.name)}</div><div class="sub">${esc(p.summary.label)}</div></span>
        ${p.claude.active ? '<span class="dot-claude" title="Claude is working here">🤖</span>' : ''}
      </button>`).join('');
    return `<aside class="sidebar">
      <button class="me" data-go="home" title="Twig">
        ${Twig.svg({ stage: m.stage.id, mood: globalMood(), size: 58 })}
        <div class="who">
          <div class="lvl" data-testid="level">Level ${m.level} · ${esc(m.title)}</div>
          <div class="tiny">${esc(m.stage.name)} · ${m.toNext} XP to next level</div>
          <div class="xpbar" aria-label="Experience"><i style="width:${Math.round(m.progress * 100)}%"></i></div>
        </div>
      </button>
      <nav class="nav">
        <button class="nav-item ${S.view === 'home' ? 'active' : ''}" data-go="home"><span class="ic">🏡</span><span class="txt"><div class="nm">Home</div></span></button>
        <div class="nav-label">Your projects</div>
        ${nav || '<div class="tiny" style="padding:4px 10px">No projects yet</div>'}
        <button class="nav-item" data-act="add" data-testid="add-project"><span class="ic">➕</span><span class="txt"><div class="nm">Add a project</div></span></button>
      </nav>
      <div class="nav-foot">
        <button class="nav-item ${S.view === 'lessons' ? 'active' : ''}" data-go="lessons" data-testid="nav-lessons"><span class="ic">📚</span><span class="txt"><div class="nm">Twig’s tips</div></span></button>
        <button class="nav-item ${S.view === 'settings' ? 'active' : ''}" data-go="settings"><span class="ic">⚙️</span><span class="txt"><div class="nm">Settings</div></span></button>
      </div>
    </aside>`;
  }

  function claudeList(sessions) {
    if (!sessions.length) return '<div class="card empty">No Claude sessions today. When Claude works in one of your projects, I’ll keep an eye on it and remind you to save.</div>';
    return `<div class="sessions">${sessions.map((s) => {
      const p = S.state.projects.find((x) => s.cwd && (s.cwd === x.path || s.cwd.startsWith(`${x.path}/`)));
      const where = p ? p.name : (s.cwd ? s.cwd.split('/').pop() : 'somewhere');
      return `<div class="card session" data-testid="claude-session">
        <span class="${s.active ? 'live' : 'idle'}" aria-hidden="true"></span>
        <div style="flex:1;min-width:0">
          <div><b>${s.active ? 'Claude is working' : 'Claude worked'}</b> in <b>${esc(where)}</b>${p ? '' : ' <span class="tiny">(not watched)</span>'}</div>
          <div class="tiny">${s.editedCount ? `changed ${plural(s.editedCount, 'file')} · ` : ''}${ago(s.lastActivity)}</div>
        </div>
        ${p ? `<button class="btn small" data-go="project" data-id="${p.id}">Open</button>` : ''}
      </div>`;
    }).join('')}</div>`;
  }

  function homeView() {
    const st = S.state;
    const sp = currentSpeech(null) || homeSpeech();
    const cards = st.projects.map((p) => `
      <button class="card pcard" data-go="project" data-id="${p.id}">
        <div class="top"><span style="font-size:22px">${p.summary.icon}</span><span class="nm">${esc(p.name)}</span>${p.claude.active ? '<span class="dot-claude">🤖 Claude</span>' : ''}</div>
        <span class="state state-${p.summary.state}">${esc(p.summary.label)}</span>
        <span class="tiny">${esc(p.summary.detail)}</span>
      </button>`).join('');
    return `${hero(sp, globalMood(), 170)}
      <div class="section"><h2>🌳 Your projects</h2>
        ${cards ? `<div class="grid">${cards}</div>` : `<div class="card empty">No projects yet. <button class="btn primary" data-act="add">➕ Add a project</button></div>`}
      </div>
      <div class="section"><h2>🤖 Claude today</h2>${claudeList(st.claudeSessions)}</div>`;
  }

  function primaryFor(p) {
    const s = p.summary.state;
    if (p.needsHelp) return { act: 'rescue', label: '🩹 Fix it for me', cls: 'warn' };
    if (s === 'untracked') return { act: 'init', label: '🌱 Start watching this folder', cls: 'primary' };
    if (s === 'unsaved') return { act: 'save', label: '💾 Save my work', cls: 'primary' };
    if (s === 'local' || s === 'ahead') return { act: 'push', label: '☁️ Back up online', cls: 'sky' };
    if (s === 'behind') return { act: 'pull', label: '📥 Get the latest', cls: 'sky' };
    return null;
  }

  function btn(act, label, cls = '', disabled = false) {
    const busy = S.busy === act;
    return `<button class="btn ${cls}" data-act="${act}" data-testid="act-${act}" ${disabled || S.busy ? 'disabled' : ''}>${busy ? '<span class="spinner"></span> Working…' : label}</button>`;
  }

  function projectView() {
    const p = project();
    if (!p) { S.view = 'home'; return homeView(); }
    const sp = currentSpeech(p.id) || projectSpeech(p);
    const prim = primaryFor(p);
    const tracked = p.isRepo;
    const secondary = tracked ? [
      p.summary.state !== 'unsaved' || (prim && prim.act !== 'save') ? btn('save', '💾 Save my work', '', !p.fileCount) : '',
      prim && prim.act === 'push' ? '' : btn('push', '☁️ Back up online', '', !p.hasCommits),
      prim && prim.act === 'pull' ? '' : btn('pull', '📥 Get the latest', '', !p.upstream),
    ].join('') : '';

    const claudeCard = p.claude.active ? `<div class="card claude-card section" data-testid="claude-here">
        <b>🤖 Claude is working in this project${p.claude.busy ? ' right now' : ''}.</b>
        <div class="muted">${p.claude.busy ? 'I’ll hold off saving until it pauses, so nothing is saved half-finished.' : 'When it finishes changing files, I’ll remind you to make a save point.'}</div>
        ${p.claude.sessions.flatMap((s) => s.gitCommands).slice(-3).map((g) => `<div class="tiny">Claude ran <code>${esc(g.command.slice(0, 80))}</code></div>`).join('')}
      </div>` : '';

    const note = tracked && p.fileCount ? (S.showNote
      ? `<div class="section" style="margin-top:14px"><input id="note" class="note-input" maxlength="200" placeholder="What did you change? (optional — I can write this for you)" value="${esc(S.note)}"></div>`
      : '<button class="btn ghost small" data-act="note" style="margin-top:8px">✍️ Add a note to this save point</button>') : '';

    return `${hero(sp, projectMood(p))}
      <div class="row" style="justify-content:space-between">
        <div><h1 data-testid="project-title">${esc(p.name)}</h1><div class="tiny">${esc(p.path)}${p.branch && p.branch !== 'main' && p.branch !== 'master' ? ` · line of work: ${esc(p.branch)}` : ''}</div></div>
        <div class="row"><button class="btn ghost small" data-act="open">📂 Open folder</button><button class="btn ghost small" data-act="remove">Stop watching</button></div>
      </div>
      <div class="card status-banner section" data-testid="status">
        <span class="big-ic" aria-hidden="true">${p.summary.icon}</span>
        <div style="flex:1"><div class="lbl">${esc(p.summary.label)}</div><div class="muted">${esc(p.summary.detail)}</div></div>
      </div>
      ${claudeCard}
      <div class="row section">${prim ? btn(prim.act, prim.label, `${prim.cls} big`) : ''}${secondary}</div>
      ${note}
      ${tracked ? `<div class="tabs" role="tablist">
        <button class="tab ${S.tab === 'changes' ? 'active' : ''}" data-tab="changes">What changed ${p.fileCount ? `(${p.fileCount})` : ''}</button>
        <button class="tab ${S.tab === 'history' ? 'active' : ''}" data-tab="history" data-testid="tab-history">🕰️ Time machine</button>
      </div>
      ${S.tab === 'changes' ? changesTab(p) : historyTab(p)}` : ''}`;
  }

  function fileRow(f, extra = '') {
    const [ic, word] = KIND[f.kind] || ['•', f.kind];
    return `<li><span aria-hidden="true">${ic}</span><span class="path" title="${esc(f.path)}">${esc(f.from ? `${f.from} → ${f.path}` : f.path)}</span><span class="kind kind-${f.kind}">${esc(word)}</span>${extra}</li>`;
  }

  function changesTab(p) {
    if (!p.fileCount) return '<div class="card empty">Nothing has changed since your last save point. 🌿</div>';
    const more = p.fileCount > p.files.length ? `<li class="tiny">…and ${p.fileCount - p.files.length} more</li>` : '';
    return `<div class="card"><ul class="files" data-testid="changed-files">${p.files.map((f) => fileRow(f)).join('')}${more}</ul></div>`;
  }

  function historyTab(p) {
    const list = S.history[p.id];
    if (!list) return '<div class="card empty">Opening the time machine…</div>';
    if (!list.length) return '<div class="card empty">No save points yet. Your first one will show up here.</div>';
    return `<ul class="timeline" data-testid="history">${list.map((c) => {
      const open = S.expanded === c.hash;
      const files = S.changes[c.hash];
      const body = open ? `<div class="body">
          ${S.explained[c.hash] ? `<div class="explain-box">🌱 ${esc(S.explained[c.hash])}</div>` : ''}
          ${files ? `<ul class="files">${files.map((f) => fileRow(f, `<button class="btn small" data-restore="${esc(f.path)}" data-hash="${c.hash}">↩️ Bring back</button>`)).join('')}</ul>` : '<div class="tiny">Looking…</div>'}
          <div class="row" style="margin-top:10px">
            <button class="btn small" data-undo="${c.hash}" data-testid="undo">⏪ Undo this save point</button>
            ${S.state.settings.ai ? `<button class="btn small ghost" data-explain="${c.hash}">✨ Explain this to me</button>` : ''}
          </div>
        </div>` : '';
      return `<li class="sp"><div class="card">
        <div class="head" data-expand="${c.hash}">
          <span class="subject">${esc(c.subject)}</span>
          ${c.backedUp ? '<span class="badge-cloud">☁️ backed up</span>' : '<span class="badge-local">💻 this computer</span>'}
          <span class="tiny">${ago(c.date)}</span>
        </div>
        <div class="tiny">${esc(c.author)} · ${plural(c.filesChanged, 'file')}</div>
        ${body}
      </div></li>`;
    }).join('')}</ul>`;
  }

  function lessonsView() {
    const seen = S.state.lessonsSeen;
    if (!S.lessons) { api.lessons().then((l) => { S.lessons = l; render(); }); return '<div class="empty">Loading…</div>'; }
    const cards = S.lessons.map((l) => `<button class="card ${seen[l.id] || seen[`read:${l.id}`] ? '' : 'unseen'}" data-lesson="${l.id}" style="text-align:left">
        <div class="chip">${esc(l.word)}</div><h3 style="margin-top:8px">${esc(l.title)}</h3>
        <div class="tiny" style="margin-top:4px">${seen[`read:${l.id}`] ? '✅ read' : seen[l.id] ? 'seen' : 'unlocks as you go'}</div>
      </button>`).join('');
    return `${hero({ title: 'Twig’s tips', text: 'Every git word I’ve taught you lives here. Tap one to read it again — reading a new one gives me a little XP!' }, 'happy', 120)}
      <div class="grid lesson-grid">${cards}</div>`;
  }

  function settingsView() {
    const st = S.state;
    const sw = (key, title, sub) => `<label class="switch"><div><b>${title}</b><div class="tiny">${sub}</div></div><input type="checkbox" data-setting="${key}" ${st.settings[key] ? 'checked' : ''}></label>`;
    return `<h1>⚙️ Settings</h1>
      <div class="card section">
        <h3>About you</h3>
        <div class="row" style="margin-top:10px">
          <input id="set-name" class="note-input" style="flex:1" placeholder="Your name" value="${esc(S.draft && 'set-name' in S.draft ? S.draft['set-name'] : st.user.name)}">
          <input id="set-email" class="note-input" style="flex:1" placeholder="Email (optional)" value="${esc(S.draft && 'set-email' in S.draft ? S.draft['set-email'] : st.user.email)}">
          <button class="btn" data-act="save-me">Save</button>
        </div>
        <div class="tiny" style="margin-top:6px">Your name labels your save points. The email is optional.</div>
      </div>
      <div class="card section">
        ${sw('ai', 'AI helpers ✨', 'Claude Haiku writes save point descriptions and Claude Sonnet explains save points when you ask. This sends the changes to Claude using your Claude login.')}
        ${sw('autoSaveAfterClaude', 'Save automatically after Claude', 'When Claude stops changing files in a project, I’ll make a save point for you so you can undo in one tap.')}
        ${sw('notifications', 'Desktop reminders', 'A gentle nudge when Claude finishes, or when work has been unsaved for a while.')}
        ${sw('showCommands', 'Show me the git commands', 'Tips will show the real git command, for when you want to learn more.')}
        ${sw('startAtLogin', 'Start Twig when I log in', 'I’ll wait quietly in the tray.')}
      </div>
      <div class="card section row" style="justify-content:space-between">
        <div><b>See tips again</b><div class="tiny">Each tip pops up once, and once more a day later. This brings them all back.</div></div>
        <button class="btn" data-act="reset-tips">Show tips again</button>
      </div>`;
  }

  // ---------- onboarding ----------
  function onboardView() {
    const o = S.onboard;
    if (o.step === 0) {
      return `<div class="onboard"><div class="box">
        ${Twig.svg({ stage: 'seed', mood: 'happy', size: 190 })}
        <h1>Hi, I’m Twig! 🌱</h1>
        <p>I look after your projects so you never lose work. I’ll save, back up and undo things for you — and teach you a little git along the way, only if you’re curious.</p>
        <button class="btn primary big" data-ob="next" data-testid="ob-start">Nice to meet you!</button>
      </div></div>`;
    }
    if (o.step === 1) {
      return `<div class="onboard"><div class="box">
        ${Twig.svg({ stage: 'seed', mood: 'curious', size: 150 })}
        <h1>What should I call you?</h1>
        <p>Your name goes on your save points, so you can tell whose work is whose.</p>
        <div class="field"><label for="ob-name">Your name</label><input id="ob-name" class="note-input" data-testid="ob-name" value="${esc(o.name)}" placeholder="e.g. Sam"></div>
        <div class="field"><label for="ob-email">Email <span class="tiny">(optional)</span></label><input id="ob-email" class="note-input" value="${esc(o.email)}" placeholder="you@example.com"></div>
        <button class="btn primary big" data-ob="name" data-testid="ob-name-next" style="margin-top:10px">Next →</button>
      </div></div>`;
    }
    const list = o.found == null ? '<div class="empty">Looking around for your projects…</div>'
      : o.found.length ? `<div class="found card" data-testid="found">${o.found.map((f) => `<label><input type="checkbox" data-pick="${f.token}" ${o.picked.has(f.token) ? 'checked' : ''}>
          <span style="flex:1">${esc(f.name)} <span class="tiny">${esc(f.path)}</span></span>${f.claude ? '<span class="tag">🤖 Claude worked here</span>' : ''}${f.isRepo ? '' : '<span class="tiny">new</span>'}</label>`).join('')}</div>`
        : '<div class="card empty">I didn’t find any projects yet. You can pick a folder yourself.</div>';
    return `<div class="onboard"><div class="box">
      ${Twig.svg({ stage: 'seed', mood: 'happy', size: 120 })}
      <h1>Which projects should I watch?</h1>
      <p>I found these folders. Tick the ones you’d like me to look after.</p>
      ${list}
      <div class="row" style="justify-content:center">
        <button class="btn primary big" data-ob="add" data-testid="ob-add">🌱 Watch these</button>
        <button class="btn" data-ob="pick">📂 Pick a folder myself</button>
        <button class="btn ghost" data-ob="skip">Skip for now</button>
      </div>
    </div></div>`;
  }

  // ---------- modal ----------
  function openModal(html, handlers = {}) {
    return new Promise((resolve) => {
      S.modals.push({ html, handlers, resolve });
      if (S.modals.length === 1) showModal();
    });
  }
  function showModal() {
    const m = S.modals[0];
    if (!m) { $modal.innerHTML = ''; return; }
    $modal.innerHTML = `<div class="overlay" data-testid="modal"><div class="modal" role="dialog" aria-modal="true">${m.html}</div></div>`;
    const b = $modal.querySelector('[data-autofocus]') || $modal.querySelector('.btn.primary') || $modal.querySelector('button');
    if (b) b.focus();
  }
  function closeModal(value) {
    const m = S.modals.shift();
    if (m) m.resolve(value);
    showModal();
  }
  $modal.addEventListener('click', (e) => {
    const el = e.target.closest('[data-m]');
    if (el) {
      const m = S.modals[0];
      const h = m && m.handlers[el.dataset.m];
      if (h) h(el); else closeModal(el.dataset.m);
    } else if (e.target.classList.contains('overlay')) closeModal(null);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.modals.length) closeModal(null); });

  function confirmBox(title, body, yes, no = 'Not now') {
    const m = S.state.mascot;
    return openModal(`<div class="twig-head">${Twig.svg({ stage: m.stage.id, mood: 'curious', size: 70 })}<h2>${esc(title)}</h2></div>
      <p>${esc(body)}</p><div class="foot"><button class="btn ghost" data-m="no">${esc(no)}</button><button class="btn primary" data-m="yes" data-testid="confirm-yes">${esc(yes)}</button></div>`).then((v) => v === 'yes');
  }

  function lessonModal(l) {
    const m = S.state.mascot;
    const read = S.state.lessonsSeen[`read:${l.id}`];
    const showCmd = S.state.settings.showCommands;
    return openModal(`<div class="twig-head">${Twig.svg({ stage: m.stage.id, mood: 'happy', size: 70 })}<div><div class="tiny">Twig’s tip</div><h2 data-testid="lesson-title">${esc(l.title)}</h2></div></div>
      <p>${esc(l.body)}</p>
      <p><span class="chip">Git word: ${esc(l.word)}</span></p>
      <div id="cmdbox">${showCmd ? `<pre class="cmd">${esc(l.command)}</pre>` : '<button class="btn ghost small" data-m="cmd">👀 Show me the git command</button>'}</div>
      <div class="foot"><button class="btn primary" data-m="ok" data-testid="lesson-ok">Got it!${read ? '' : ' (+5 XP)'}</button></div>`, {
      cmd: () => { document.getElementById('cmdbox').innerHTML = `<pre class="cmd">${esc(l.command)}</pre>`; },
      ok: async () => {
        closeModal('ok');
        const r = await api.lessonRead(l.id);
        if (r && r.award) celebrate(r.award);
      },
    });
  }

  function levelUpModal(a) {
    const leaves = ['🍃', '🌱', '🌸', '✨', '🍀', '🌼'];
    const conf = document.createElement('div');
    conf.className = 'confetti';
    conf.innerHTML = Array.from({ length: 36 }, () => `<i style="left:${Math.random() * 100}vw;animation-duration:${2 + Math.random() * 2.5}s;animation-delay:${Math.random() * 0.8}s">${leaves[Math.floor(Math.random() * leaves.length)]}</i>`).join('');
    document.body.appendChild(conf);
    setTimeout(() => conf.remove(), 5500);
    const grew = a.stageUp ? `I grew into a <b>${esc(a.stage.name)}</b>!` : 'I’m getting stronger!';
    return openModal(`<div class="levelup" data-testid="levelup">${Twig.svg({ stage: a.stage.id, mood: 'proud', size: 180 })}
      <h1>Level ${a.level}!</h1><p>${grew} You’re now a <b>${esc(a.title)}</b>. Thanks for looking after your work so well.</p>
      <div class="foot" style="justify-content:center"><button class="btn primary big" data-m="ok">Yay! 🎉</button></div></div>`);
  }

  function celebrate(a) {
    if (!a) return;
    if (a.gained) xpToast(a.gained);
    if (a.badge) toast(`🏅 ${a.badge}`);
    if (a.levelUp || a.stageUp) { S.proudUntil = Date.now() + 8000; levelUpModal(a); }
  }

  async function githubHelpModal(gh) {
    const m = S.state.mascot;
    const steps = !gh || !gh.installed
      ? '<p>First, GitHub’s helper app needs installing. Open a terminal and type:</p><pre class="cmd">brew install gh</pre><p>Then:</p><pre class="cmd">gh auth login</pre>'
      : '<p>Open a terminal and type this, then follow the steps it shows you (pick “GitHub.com” and “Login with a web browser”):</p><pre class="cmd">gh auth login</pre>';
    return openModal(`<div class="twig-head">${Twig.svg({ stage: m.stage.id, mood: 'curious', size: 70 })}<h2>Let’s connect you to GitHub</h2></div>
      <p>GitHub is a website that keeps an online copy of your projects. It needs to know this computer is yours — you only do this once.</p>
      ${steps}
      <p class="tiny">When you’re done, come back and tap “Back up online” again.</p>
      <div class="foot"><button class="btn primary" data-m="ok">OK, I’ll do that</button></div>`);
  }

  // ---------- actions ----------
  const SUCCESS = {
    init: () => ({ title: 'I’m watching this folder now! 🌱', text: 'Next, tap “Save my work” to make your very first save point.' }),
    save: (r) => ({ title: 'Saved! 💾', text: `I made a save point: “${r.message}”. You can come back to this moment any time from the Time machine.` }),
    push: (r) => ({ title: 'Backed up online! ☁️', text: r.firstTime ? 'Your project is on GitHub now. Even if this computer takes a nap forever, your work is safe.' : 'GitHub has all your save points now.' }),
    pull: (r) => (r.upToDate ? { title: 'Already up to date', text: 'You have everything GitHub has. 🌿' } : { title: 'Got the latest! 📥', text: `I brought ${plural(r.count, 'new save point')} from GitHub${r.merged ? ' and combined them with yours — they didn’t overlap, so it was easy' : ''}.` }),
    undo: () => ({ title: 'Undone! ⏪', text: 'I made a new save point that reverses that one. The old one is still in the Time machine, just in case.' }),
    restore: (r) => ({ title: 'File brought back! ↩️', text: r.backup ? 'Your newer version is tucked safely in a backup, in case you want it again.' : 'It’s back just how it was in that save point.' }),
    rescue: (r) => ({ title: 'All fixed! 🩹', text: r.rescueBranch ? `You’re back on your main line of work. The changes you’d made are kept safe on a separate line called “${r.rescueBranch}”.` : r.backupDir ? `Everything is back to normal. I kept copies of the files it touched in ${r.backupDir}.` : 'Everything is back to normal.' }),
    githubHome: (r) => ({ title: 'Your project has an online home! 🏡', text: `It’s private — only you can see it${r.url ? ` at ${r.url}` : ''}.` }),
  };

  async function run(act, ...args) {
    const p = project();
    if (!p || S.busy) return;
    S.busy = act;
    render();
    let res;
    try {
      res = await api[act](p.id, ...args);
    } catch {
      res = { ok: false, problem: { title: 'Something went wrong', body: 'Nothing was changed. Try again?', fix: 'retry' } };
    }
    S.busy = null;
    await handleResult(act, res, args);
    refresh();
  }

  const FIX_LABEL = { retry: '🔁 Try again', 'github-login': '🔑 Show me how', pull: '📥 Get the latest', save: '💾 Save my work', 'save-anyway': 'Save anyway', init: '🌱 Start watching', rescue: '🩹 Fix it for me', settings: '⚙️ Open settings', 'github-home': '🏡 Make one for me', remove: 'Stop watching it', push: '☁️ Back up online' };

  async function handleResult(act, res, args) {
    if (!res.ok) {
      if (act === 'push' && res.result && res.result.reason === 'needs-remote') {
        const gh = res.github || {};
        if (gh.loggedIn) {
          const yes = await confirmBox('Make an online home?', `This project isn’t on GitHub yet. Shall I make a private home for “${project().name}” on your GitHub? Only you will be able to see it.`, '🏡 Yes, make it');
          if (yes) return run('githubHome');
          return render();
        }
        return githubHelpModal(gh);
      }
      const pr = res.problem || { title: 'That didn’t work', body: 'Nothing was changed.' };
      if (pr.fix === 'github-login') return githubHelpModal(await api.githubStatus());
      S.lastAction = { act, args };
      const actions = pr.fix && FIX_LABEL[pr.fix] ? [{ label: FIX_LABEL[pr.fix], fix: pr.fix, primary: true }] : [];
      return sayNow({ title: pr.title, text: pr.body, mood: pr.key === 'claude-busy' ? 'curious' : 'worried', actions });
    }
    const r = res.result || {};
    if (act === 'save' && r.nothing && !(r.excluded && r.excluded.length)) return sayNow({ title: 'Everything is already saved', text: 'There’s nothing new to save. Nice and tidy! 🌿' });
    const sp = SUCCESS[act] ? SUCCESS[act](r) : { title: 'Done!', text: '' };
    if (act === 'save' && r.excluded && r.excluded.length) {
      const why = r.excluded.map((x) => `${x.path} (${x.reason === 'secret' ? 'looks like a password or key' : 'too big for GitHub'})`).join(', ');
      sp.text = `${r.nothing ? 'I didn’t save anything, because' : `${sp.text} But`} I kept ${plural(r.excluded.length, 'file')} out: ${why}. Keep ${r.excluded.length === 1 ? 'it' : 'them'} out for good?`;
      sp.actions = [{ label: '🙈 Yes, keep them out', fix: 'ignore', primary: true }];
      S.excluded = r.excluded.map((x) => x.path);
    }
    if (act === 'save') { S.note = ''; S.showNote = false; }
    if (act === 'rescue' || act === 'githubHome' || act === 'push' || act === 'pull' || act === 'undo' || act === 'save') delete S.history[project().id];
    if (res.award) S.proudUntil = Date.now() + 4000;
    sayNow({ ...sp, mood: 'proud' });
    celebrate(res.award);
    if (res.lesson) lessonModal(res.lesson);
    if (res.excludedLesson) lessonModal(res.excludedLesson);
    if (res.levelLesson) lessonModal(res.levelLesson);
    if (S.tab === 'history') loadHistory();
  }

  async function doFix(fix) {
    const p = project();
    if (fix.startsWith('open:')) {
      S.view = 'project'; S.projectId = fix.slice(5); S.tab = 'changes';
      S.speech = { ...S.speech, projectId: S.projectId, actions: [{ label: '💾 Save my work', fix: 'save', primary: true }] };
      return render();
    }
    switch (fix) {
      case 'add': return addProjectModal();
      case 'retry': if (S.lastAction) return run(S.lastAction.act, ...S.lastAction.args); return refresh();
      case 'save-anyway': return run('save', { anyway: true, message: S.note });
      case 'save': return run('save', { message: S.note });
      case 'pull': case 'init': case 'rescue': case 'push': return run(fix);
      case 'github-home': return run('githubHome');
      case 'github-login': return githubHelpModal(await api.githubStatus());
      case 'settings': S.view = 'settings'; return render();
      case 'remove': if (p) { await api.removeProject(p.id); S.view = 'home'; S.speech = null; } return refresh();
      case 'ignore': {
        if (!p || !S.excluded) return undefined;
        const r = await api.ignoreForever(p.id, S.excluded);
        S.excluded = null;
        return sayNow({ title: 'Kept out for good 🙈', text: `I added ${plural(r.added || 0, 'file')} to this project’s .gitignore list, so I won’t ask again.`, mood: 'happy' });
      }
      default: return undefined;
    }
  }

  async function loadHistory() {
    const p = project();
    if (!p) return;
    const r = await api.history(p.id);
    S.history[p.id] = r.ok ? r.history : [];
    render();
    if (r.lesson) lessonModal(r.lesson);
  }

  async function addProjectModal() {
    const found = await api.discover();
    const items = found.map((f) => `<label><input type="checkbox" data-pick="${f.token}"><span style="flex:1">${esc(f.name)} <span class="tiny">${esc(f.path)}</span></span>${f.claude ? '<span class="tag">🤖 Claude</span>' : ''}</label>`).join('');
    const m = S.state.mascot;
    const picked = new Set();
    openModal(`<div class="twig-head">${Twig.svg({ stage: m.stage.id, mood: 'curious', size: 70 })}<h2>Add a project</h2></div>
      ${items ? `<p>Here are some folders I found. Tick any you want me to watch.</p><div class="found">${items}</div>` : '<p>I didn’t find any new folders nearby.</p>'}
      <div class="foot"><button class="btn" data-m="pick">📂 Pick a folder…</button>${items ? '<button class="btn primary" data-m="add" data-testid="add-picked">Watch these</button>' : ''}</div>`, {
      pick: async () => { closeModal(); const r = await api.pickFolder(); if (r.ok) { S.view = 'project'; S.projectId = r.id; } refresh(); },
      add: async () => {
        $modal.querySelectorAll('[data-pick]').forEach((c) => c.checked && picked.add(c.dataset.pick));
        closeModal();
        const r = await api.addDiscovered([...picked]);
        if (r.added && r.added.length === 1) { S.view = 'project'; S.projectId = r.added[0]; }
        refresh();
      },
    });
  }

  // ---------- events ----------
  $app.addEventListener('click', async (e) => {
    const t = e.target.closest('button, [data-expand]');
    if (!t) return;
    const d = t.dataset;
    if (d.go) {
      S.view = d.go;
      if (d.id) { if (S.projectId !== d.id) { S.tab = 'changes'; S.expanded = null; S.note = ''; S.showNote = false; } S.projectId = d.id; }
      if (S.speech && S.speech.projectId !== S.projectId) S.speech = null;
      render();
      $app.querySelector('.main') && ($app.querySelector('.main').scrollTop = 0);
      return;
    }
    if (d.fix) return doFix(d.fix);
    if (d.tab) { S.tab = d.tab; render(); if (d.tab === 'history') loadHistory(); return; }
    if (d.lesson) { const l = S.lessons.find((x) => x.id === d.lesson); if (l) lessonModal(l); return; }
    if (d.expand) {
      S.expanded = S.expanded === d.expand ? null : d.expand;
      render();
      if (S.expanded && !S.changes[d.expand]) {
        const r = await api.changesIn(S.projectId, d.expand);
        S.changes[d.expand] = r.ok ? r.files : [];
        render();
      }
      return;
    }
    if (d.undo) {
      const c = (S.history[S.projectId] || []).find((x) => x.hash === d.undo);
      if (await confirmBox('Undo this save point?', `I’ll make a new save point that reverses “${c ? c.subject : 'it'}”. Nothing gets erased — the old one stays in the Time machine.`, '⏪ Undo it')) run('undo', d.undo);
      return;
    }
    if (d.restore) {
      if (await confirmBox('Bring this file back?', `I’ll bring back ${d.restore} as it was in this save point. If you’ve changed it since, I’ll keep your current version in a backup first.`, '↩️ Bring it back')) run('restore', d.hash, d.restore);
      return;
    }
    if (d.explain) {
      S.explained[d.explain] = 'Thinking about it…';
      render();
      const r = await api.explainSavePoint(S.projectId, d.explain);
      S.explained[d.explain] = r.ok ? r.text : 'I couldn’t reach Claude just now. Try again in a bit?';
      render();
      return;
    }
    switch (d.act) {
      case 'add': return addProjectModal();
      case 'note': S.showNote = true; render(); document.getElementById('note')?.focus(); return;
      case 'save': return run('save', { message: S.note });
      case 'init': case 'push': case 'pull': case 'rescue': return run(d.act);
      case 'open': return api.openFolder(S.projectId);
      case 'remove': {
        const p = project();
        if (p && await confirmBox('Stop watching this project?', `I’ll stop looking after “${p.name}”. Your files and save points stay exactly where they are.`, 'Stop watching', 'Keep watching')) {
          await api.removeProject(p.id); S.view = 'home'; refresh();
        }
        return;
      }
      case 'save-me':
        await api.setSettings({ name: document.getElementById('set-name').value, email: document.getElementById('set-email').value });
        S.draft = null;
        toast('Saved your details ✅');
        return;
      case 'reset-tips': await api.resetTips(); toast('Tips will show again 📚'); return;
      default:
    }
  });

  $app.addEventListener('input', (e) => {
    const { id, value } = e.target;
    if (id === 'note') S.note = value;
    else if (id === 'ob-name') S.onboard.name = value;
    else if (id === 'ob-email') S.onboard.email = value;
    else if (id === 'set-name' || id === 'set-email') S.draft = { ...S.draft, [id]: value };
  });
  $app.addEventListener('keydown', (e) => { if (e.target.id === 'note' && e.key === 'Enter') run('save', { message: S.note }); });
  $app.addEventListener('change', async (e) => {
    const t = e.target;
    if (t.dataset.setting) { await api.setSettings({ [t.dataset.setting]: t.checked }); toast('Setting saved ✅'); }
    if (t.dataset.pick) { if (t.checked) S.onboard.picked.add(t.dataset.pick); else S.onboard.picked.delete(t.dataset.pick); }
  });

  // onboarding clicks
  $app.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-ob]');
    if (!b) return;
    const o = S.onboard;
    if (b.dataset.ob === 'next') { o.step = 1; render(); document.getElementById('ob-name')?.focus(); return; }
    if (b.dataset.ob === 'name') {
      o.name = document.getElementById('ob-name').value.trim();
      o.email = document.getElementById('ob-email').value.trim();
      o.step = 2;
      render();
      o.found = await api.discover();
      o.picked = new Set(o.found.filter((f) => f.isRepo || f.claude).map((f) => f.token));
      render();
      return;
    }
    const finishOnboard = async () => {
      await api.onboard({ name: o.name, email: o.email });
      S.view = 'home';
      S.speech = { at: Date.now(), projectId: null, title: o.name ? `Welcome, ${o.name.split(' ')[0]}! 🌱` : 'Welcome! 🌱', text: 'I’ll keep an eye on your projects and on Claude. Tap a project to see what’s changed, and I’ll help you save it.' };
      await refresh();
    };
    if (b.dataset.ob === 'add') { await api.addDiscovered([...o.picked]); return finishOnboard(); }
    if (b.dataset.ob === 'pick') { await api.pickFolder(); return finishOnboard(); }
    if (b.dataset.ob === 'skip') return finishOnboard();
  });

  // ---------- render loop ----------
  function render() {
    if (!S.state) { $app.innerHTML = '<div class="onboard"><div class="box">Loading…</div></div>'; return; }
    const active = document.activeElement;
    const focusId = active && active.id;
    const sel = focusId && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;
    const scroller = $app.querySelector('.main');
    const scroll = scroller ? scroller.scrollTop : 0;

    if (!S.state.user.onboarded) {
      $app.innerHTML = onboardView();
    } else {
      const body = S.view === 'project' ? projectView() : S.view === 'lessons' ? lessonsView() : S.view === 'settings' ? settingsView() : homeView();
      $app.innerHTML = `<div class="shell">${sidebar()}<main class="main"><div class="main-inner">${body}</div></main></div>`;
      const m = $app.querySelector('.main');
      if (m) m.scrollTop = scroll;
    }
    if (focusId) {
      const el = document.getElementById(focusId);
      if (el) { el.focus(); if (sel) try { el.setSelectionRange(sel[0], sel[1]); } catch { /* not a text field */ } }
    }
  }

  async function refresh() {
    S.state = await api.refresh();
    render();
  }

  api.onState((s) => {
    S.state = s;
    render();
  });

  api.onTwig((msg) => {
    const p = S.state && S.state.projects.find((x) => x.id === msg.projectId);
    const actions = msg.kind === 'claude-quiet' ? [{ label: '💾 Save my work', fix: 'save', primary: true }] : [];
    if (msg.kind === 'claude-quiet' || msg.kind === 'auto-saved' || msg.kind === 'claude-git') {
      S.speech = { at: Date.now(), projectId: S.view === 'project' ? msg.projectId : null, title: msg.kind === 'auto-saved' ? 'Saved Claude’s work 🌱' : msg.kind === 'claude-git' ? 'Claude used git' : 'Claude finished!', text: msg.text, mood: msg.kind === 'claude-git' ? 'curious' : 'happy', actions: S.view === 'project' && S.projectId === msg.projectId ? actions : (p ? [{ label: `Open ${p.name}`, fix: `open:${p.id}`, primary: true }] : []) };
      render();
      if (msg.award) celebrate(msg.award);
      if (msg.lesson) lessonModal(msg.lesson);
    }
  });

  // relative times drift; re-render gently once a minute
  setInterval(() => { if (!S.modals.length && !(document.activeElement && document.activeElement.tagName === 'INPUT')) render(); }, 60000);

  api.getState().then((s) => { S.state = s; render(); });
  render();
})();
