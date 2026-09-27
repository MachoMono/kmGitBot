'use strict';
// Bite-size lessons. One idea each, shown right after the user does the thing.

const LESSONS = [
  {
    id: 'commit', after: 'save', word: 'commit',
    title: 'You made a save point!',
    body: 'A save point is a snapshot of your whole project at this moment. You can always come back to it. In git, a save point is called a commit.',
    command: 'git add -A\ngit commit -m "your message"',
  },
  {
    id: 'push', after: 'push', word: 'push',
    title: 'Your work is backed up online',
    body: 'Your save points now live on GitHub too, so they’re safe even if this computer isn’t. Sending save points to GitHub is called pushing.',
    command: 'git push',
  },
  {
    id: 'pull', after: 'pull', word: 'pull',
    title: 'You got the latest',
    body: 'You brought newer save points from GitHub onto this computer. That’s called pulling.',
    command: 'git pull',
  },
  {
    id: 'log', after: 'history', word: 'log',
    title: 'The time machine',
    body: 'This is every save point, newest first. Git calls this list the log or history.',
    command: 'git log',
  },
  {
    id: 'revert', after: 'undo', word: 'revert',
    title: 'Undo, the safe way',
    body: 'Instead of erasing the old save point, I made a new one that reverses it — so the history stays honest and nothing is lost. Git calls this reverting.',
    command: 'git revert <save point>',
  },
  {
    id: 'restore', after: 'restore', word: 'restore',
    title: 'A file came back in time',
    body: 'I brought one file back to how it was in an older save point. If it had changes, I tucked them into a backup first (git calls that backup shelf the stash).',
    command: 'git stash push -- <file>\ngit restore --source=<save point> -- <file>',
  },
  {
    id: 'init', after: 'init', word: 'repository',
    title: 'This folder is now watched',
    body: 'I can keep save points for this folder now. A folder with save points is called a repository, or “repo” for short.',
    command: 'git init',
  },
  {
    id: 'gitignore', after: 'excluded', word: '.gitignore',
    title: 'Some files are kept out',
    body: 'Passwords, keys and huge files shouldn’t go in save points. A file called .gitignore lists what git should leave alone.',
    command: 'echo ".env" >> .gitignore',
  },
  {
    id: 'remote', after: 'githubHome', word: 'remote',
    title: 'Your project has an online home',
    body: 'GitHub now keeps a copy of this project. The online copy is called a remote, and its usual nickname is “origin”.',
    command: 'gh repo create --private --source . --push',
  },
  {
    id: 'branch', after: 'level:4', word: 'branch',
    title: 'Lines of work (branches)',
    body: 'Git can keep separate lines of work side by side, like the branches on me! People use them to try an idea without touching the main version. Your main line is usually called main.',
    command: 'git switch -c my-idea',
  },
  {
    id: 'claude', after: 'claude-quiet', word: 'diff',
    title: 'Why save after Claude?',
    body: 'Claude can change lots of files quickly. A save point right after means you can see exactly what changed (a diff) and undo it in one tap if you don’t like it.',
    command: 'git diff',
  },
  {
    id: 'merge', after: 'level:7', word: 'merge',
    title: 'Combining work',
    body: 'When two lines of work change different things, git can combine them automatically — that’s a merge. If they change the same lines, a human has to choose. I always stop and ask rather than guess.',
    command: 'git merge <branch>',
  },
];

// Pick the lesson for an event, unless it's already been shown twice.
function forEvent(event, seen = {}) {
  const l = LESSONS.find((x) => x.after === event);
  if (!l || (seen[l.id] || 0) >= 2) return null;
  return l;
}

module.exports = { LESSONS, forEvent };
