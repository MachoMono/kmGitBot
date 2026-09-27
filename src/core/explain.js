'use strict';
// Plain-English for everything git says. Rule: no scary words in anything the user reads.

const BANNED_WORDS = ['force', 'hard', 'reset', 'abort', 'fatal', 'HEAD', 'detached', 'rebase', 'error:'];

// [pattern, { title, body, fix }]  — fix is an action id the UI knows how to offer.
const PATTERNS = [
  [/could not resolve host|network is unreachable|unable to access.*(timed out|couldn't connect)|connection (timed out|refused)|Could not read from remote repository\.\s*$/im,
    { key: 'offline', title: "Looks like you're offline", body: "I couldn't reach the internet. Nothing is lost — your save points are safe on this computer. Try again when you're connected.", fix: 'retry' }],
  [/authentication failed|could not read username|permission denied \(publickey\)|terminal prompts disabled|403|invalid username or password/i,
    { key: 'auth', title: 'GitHub needs to know it’s you', body: "GitHub didn't recognise this computer yet. It's a one-time setup: open a terminal and type  gh auth login  then follow the steps. I'll be right here.", fix: 'github-login' }],
  [/repository not found/i,
    { key: 'no-repo-online', title: "I can't find this project on GitHub", body: 'The online copy may have been renamed, deleted, or you may not have access to it.', fix: null }],
  [/\[rejected\].*(fetch first|non-fast-forward)|updates were rejected/i,
    { key: 'behind', title: 'GitHub has newer work', body: 'Someone (maybe you, on another computer) sent newer changes to GitHub. Get the latest first, then back up again.', fix: 'pull' }],
  [/exceeds GitHub's file size limit|large files detected|GH001/i,
    { key: 'too-big', title: 'A file is too big for GitHub', body: "GitHub won't take files over 100 MB. I'll help you keep that file out of your save points.", fix: null }],
  [/index\.lock.*exists|Unable to create .*index\.lock/i,
    { key: 'lock', title: 'Git is still busy', body: 'Another program is using this project right now. Wait a moment and try again.', fix: 'retry' }],
  [/nothing to commit|no changes added to commit/i,
    { key: 'nothing', title: 'Everything is already saved', body: 'There are no new changes to save. Nice and tidy!', fix: null }],
  [/please tell me who you are|empty ident name|unable to auto-detect email/i,
    { key: 'identity', title: 'Tell me your name', body: 'Save points are labelled with a name. Add yours in Settings and try again.', fix: 'settings' }],
  [/not a git repository/i,
    { key: 'not-repo', title: "I'm not watching this folder yet", body: 'Tap “Start watching this folder” and I’ll start keeping save points for it.', fix: 'init' }],
];

const REASONS = {
  'not-repo': PATTERNS.find((p) => p[1].key === 'not-repo')[1],
  'needs-remote': { key: 'needs-remote', title: 'This project has no online home yet', body: 'To back it up online, it needs a home on GitHub. I can make a private one for you.', fix: 'github-home' },
  'no-upstream': { key: 'no-upstream', title: 'Back it up once first', body: 'This project hasn’t been sent to GitHub yet, so there’s nothing newer to get. Back it up online first.', fix: 'push' },
  'no-commits': { key: 'no-commits', title: 'Make a save point first', body: 'There’s nothing to send yet. Save your work first, then back it up.', fix: 'save' },
  'unsaved-changes': { key: 'unsaved-changes', title: 'Save your work first', body: 'You have changes that aren’t in a save point yet. Save them first so nothing can get mixed up.', fix: 'save' },
  conflict: { key: 'conflict', title: 'You and GitHub both changed the same lines', body: 'I stopped before anything was mixed together — your files are exactly as they were. Ask Claude to “get the latest changes from GitHub and combine them with mine”, or ask a friend who knows git.', fix: null },
  'merge-commit': { key: 'merge-commit', title: 'That save point joined two lines of work', body: 'Undoing it safely needs a human decision, so I left it alone.', fix: null },
  'first-commit': { key: 'first-commit', title: 'That’s the very first save point', body: 'There’s nothing before it to go back to. You can bring back single files instead.', fix: null },
  'not-found': { key: 'not-found', title: 'That file isn’t in this save point', body: 'Pick a different save point to bring it back from.', fix: null },
  'backup-failed': { key: 'backup-failed', title: 'I couldn’t make a backup first', body: 'So I didn’t touch the file. Your current version is safe.', fix: null },
  'claude-busy': { key: 'claude-busy', title: 'Claude is still working here', body: 'Claude changed files a moment ago. I’ll wait until it pauses so I don’t save a half-finished file.', fix: 'save-anyway' },
  busy: { key: 'busy', title: 'Git is still busy', body: 'Another program is using this project right now. Wait a moment and try again.', fix: 'retry' },
  'gh-error': { key: 'gh-error', title: 'GitHub said no', body: 'I couldn’t create the online home. It may already exist with that name, or GitHub needs you to log in again.', fix: 'github-login' },
  'has-remote': { key: 'has-remote', title: 'Already has an online home', body: 'This project is already connected to GitHub.', fix: null },
};

const HELP = {
  detached: { key: 'detached', title: 'You’re looking at an old save point', body: 'This project is showing an older moment in time instead of your main line of work. I can take you back — any changes you made here will be kept safe on their own line.', fix: 'rescue' },
  merge: { key: 'merge', title: 'A combine was left half-finished', body: 'Something started combining two versions and didn’t finish. I can cancel it — I’ll copy every file it touched to a backup first.', fix: 'rescue' },
  rebase: { key: 'rebase', title: 'A rewrite was left half-finished', body: 'Something started reshuffling save points and didn’t finish. I can cancel it — I’ll copy every file it touched to a backup first.', fix: 'rescue' },
  revert: { key: 'revert', title: 'An undo was left half-finished', body: 'I can cancel it and put things back how they were.', fix: 'rescue' },
  'cherry-pick': { key: 'cherry-pick', title: 'A copy was left half-finished', body: 'I can cancel it and put things back how they were.', fix: 'rescue' },
  lock: { key: 'lock', title: 'Git got stuck', body: 'A program using git stopped suddenly and left a “busy” sign up. I can take it down.', fix: 'rescue' },
};

function fromGitError(err) {
  const text = `${(err && err.stderr) || ''}\n${(err && err.stdout) || ''}\n${(err && err.message) || ''}`;
  for (const [re, msg] of PATTERNS) if (re.test(text)) return { ...msg };
  return { key: 'unknown', title: 'Something unexpected happened', body: 'Git said something I don’t recognise, so I stopped. Your files haven’t been changed.', fix: null, details: text.trim().slice(0, 2000) };
}

function fromResult(res) {
  if (!res || res.ok) return null;
  if (res.reason === 'git-error') return fromGitError(res.error);
  if (res.reason === 'needs-help') return { ...HELP[res.needsHelp] };
  return REASONS[res.reason] ? { ...REASONS[res.reason] } : { key: res.reason, title: 'That didn’t work', body: 'Nothing was changed.', fix: null };
}

const KIND_WORDS = { new: 'new file', edited: 'edited', deleted: 'deleted', renamed: 'renamed', conflict: 'needs a decision' };

function summarizeStatus(st) {
  if (!st || !st.isRepo) return { state: 'untracked', icon: '🌱', label: 'Not watched yet', detail: 'Start watching to keep save points' };
  if (st.needsHelp) return { state: 'help', icon: '🆘', label: 'Needs a hand', detail: HELP[st.needsHelp].title };
  const n = st.files.length;
  if (n) return { state: 'unsaved', icon: '✏️', label: `${n} unsaved change${n === 1 ? '' : 's'}`, detail: 'Save your work to make a save point' };
  if (!st.hasCommits) return { state: 'empty', icon: '🌱', label: 'Ready for its first save point', detail: 'Nothing saved yet' };
  if (!st.hasRemote) return { state: 'local', icon: '💻', label: 'All saved on this computer', detail: 'Not backed up online yet' };
  if (!st.upstream) return { state: 'ahead', icon: '☁️', label: 'All saved', detail: 'Never backed up online' };
  if (st.ahead) return { state: 'ahead', icon: '☁️', label: 'All saved', detail: `${st.ahead} save point${st.ahead === 1 ? '' : 's'} not backed up online` };
  if (st.behind) return { state: 'behind', icon: '📥', label: 'Newer work on GitHub', detail: 'Get the latest' };
  return { state: 'clean', icon: '✅', label: 'All saved and backed up', detail: 'Nothing to do — nice!' };
}

function hasBannedWords(text) {
  return BANNED_WORDS.filter((w) => new RegExp(`\\b${w.replace(':', '')}\\b`, w === 'HEAD' ? '' : 'i').test(text));
}

module.exports = { fromGitError, fromResult, summarizeStatus, hasBannedWords, KIND_WORDS, REASONS, HELP, PATTERNS, BANNED_WORDS };
