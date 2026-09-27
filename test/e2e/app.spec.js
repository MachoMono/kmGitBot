'use strict';
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SHOTS = path.join(__dirname, 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });
const GITENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const g = (cwd, ...a) => execFileSync('git', a, { cwd, env: GITENV, encoding: 'utf8' });

function sandbox() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kmgit-e2e-')));
  const dirs = { home: path.join(base, 'home'), claude: path.join(base, 'claude'), projects: path.join(base, 'projects') };
  Object.values(dirs).forEach((d) => fs.mkdirSync(d, { recursive: true }));
  const garden = path.join(dirs.projects, 'garden');
  fs.mkdirSync(garden);
  g(garden, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(garden, 'poem.txt'), 'Roses are red\n');
  g(garden, 'add', '-A');
  g(garden, '-c', 'user.name=Sam', '-c', 'user.email=sam@example.com', 'commit', '-qm', 'Start my poem');
  fs.mkdirSync(path.join(dirs.projects, 'notes')); // plain folder, not a repo yet
  return { ...dirs, garden };
}

async function launch(sb) {
  const app = await electron.launch({
    args: [ROOT],
    cwd: ROOT,
    env: {
      ...GITENV,
      PATH: '/usr/bin:/bin', // keeps the real `gh` and `claude` out of reach
      KMGIT_E2E: '1', KMGIT_NO_AI: '1',
      KMGIT_HOME: sb.home, KMGIT_CLAUDE_DIR: sb.claude, KMGIT_DISCOVER_DIRS: sb.projects,
      KMGIT_QUIET_MS: '1500', KMGIT_SCAN_MS: '400', KMGIT_POLL_MS: '600',
    },
  });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1180, height: 820 }).catch(() => {});
  return { app, page };
}

const bubble = (page) => page.getByTestId('bubble').first();
async function closeLesson(page, title) {
  await expect(page.getByTestId('lesson-title')).toHaveText(title);
  await page.getByTestId('lesson-ok').click();
}

test('a non-git user onboards, saves, gets nudged about Claude, levels up and uses the time machine', async () => {
  const sb = sandbox();
  const { app, page } = await launch(sb);
  try {
    // --- onboarding
    await expect(page.getByText('Hi, I’m Twig!')).toBeVisible();
    await page.screenshot({ path: path.join(SHOTS, '01-welcome.png') });
    await page.getByTestId('ob-start').click();
    await page.getByTestId('ob-name').fill('Sam Rivera');
    await page.getByTestId('ob-name-next').click();
    const found = page.getByTestId('found');
    await expect(found).toContainText('garden');
    await expect(found).toContainText('notes');
    await expect(found.locator('label', { hasText: 'garden' }).locator('input')).toBeChecked();
    await expect(found.locator('label', { hasText: 'notes' }).locator('input')).not.toBeChecked();
    await page.getByTestId('ob-add').click();
    await expect(bubble(page)).toContainText('Welcome, Sam!');
    await expect(page.getByTestId('level')).toContainText('Level 1');

    // --- make a change and save it
    fs.appendFileSync(path.join(sb.garden, 'poem.txt'), 'Violets are blue\n');
    await expect(page.getByTestId('nav-project')).toContainText('1 unsaved change');
    await page.screenshot({ path: path.join(SHOTS, '02-home.png') });
    await page.getByTestId('nav-project').click();
    await expect(page.getByTestId('project-title')).toHaveText('garden');
    await expect(page.getByTestId('changed-files')).toContainText('poem.txt');
    await expect(page.getByTestId('changed-files')).toContainText('edited');
    await page.screenshot({ path: path.join(SHOTS, '03-project-unsaved.png') });
    await page.getByTestId('act-save').first().click();
    await closeLesson(page, 'You made a save point!');
    await expect(bubble(page)).toContainText('Saved!');
    await expect(bubble(page)).toContainText('Update poem.txt');
    expect(g(sb.garden, 'log', '-1', '--format=%s|%an').trim()).toBe('Update poem.txt|Sam Rivera');
    await expect(page.getByTestId('status')).toContainText('All saved on this computer');

    // --- Claude edits the project: Twig waits while it's busy, then nudges
    const slug = path.join(sb.claude, sb.garden.replace(/\//g, '-'));
    fs.mkdirSync(slug, { recursive: true });
    const log = path.join(slug, 'sess-e2e.jsonl');
    fs.writeFileSync(log, '');
    await page.waitForTimeout(800); // let the watcher see the empty log first
    fs.appendFileSync(path.join(sb.garden, 'poem.txt'), 'Sugar is sweet\n');
    fs.appendFileSync(log, `${JSON.stringify({
      type: 'assistant', sessionId: 'sess-e2e', cwd: sb.garden, gitBranch: 'main', timestamp: new Date().toISOString(),
      message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: path.join(sb.garden, 'poem.txt') } }] },
    })}\n`);
    await expect(page.getByTestId('claude-here')).toBeVisible();
    await expect(bubble(page)).toContainText('Claude finished!');
    await closeLesson(page, 'Why save after Claude?');
    await page.screenshot({ path: path.join(SHOTS, '04-claude-nudge.png') });
    // Claude touched files moments ago, so a save is held back until it pauses
    await page.getByTestId('act-save').first().click();
    await expect(bubble(page)).toContainText('Claude is still working here');
    await page.getByRole('button', { name: 'Save anyway' }).click();
    // 35 (first save) + 5 (lesson) + 5 (lesson) + 10 = 55 → level 2, Twig becomes a Sprout
    await expect(page.getByTestId('levelup')).toContainText('Level 2');
    await expect(page.getByTestId('levelup')).toContainText('Sprout');
    await page.screenshot({ path: path.join(SHOTS, '05-level-up.png') });
    await page.getByRole('button', { name: 'Yay! 🎉' }).click();
    await expect(page.getByTestId('level')).toContainText('Level 2');
    await expect(page.locator('.sidebar svg.twig')).toHaveClass(/stage-sprout/);

    // --- time machine and a safe undo
    await page.getByTestId('tab-history').click();
    await closeLesson(page, 'The time machine');
    const history = page.getByTestId('history');
    await expect(history.locator('.sp')).toHaveCount(3);
    await expect(history).toContainText('💻 this computer');
    await page.screenshot({ path: path.join(SHOTS, '06-time-machine.png') });
    await history.locator('.sp').first().locator('.head').click();
    await expect(history.locator('.sp').first()).toContainText('poem.txt');
    await page.getByTestId('undo').click();
    await page.getByTestId('confirm-yes').click();
    await closeLesson(page, 'Undo, the safe way');
    await expect(bubble(page)).toContainText('Undone!');
    expect(fs.readFileSync(path.join(sb.garden, 'poem.txt'), 'utf8')).toBe('Roses are red\nViolets are blue\n');
    await expect(history.locator('.sp')).toHaveCount(4);

    // --- backing up with no online home and no GitHub helper: gentle guidance, no crash
    await page.getByTestId('act-push').first().click();
    await expect(page.getByTestId('modal')).toContainText('Let’s connect you to GitHub');
    await expect(page.getByTestId('modal')).toContainText('gh auth login');
    await page.screenshot({ path: path.join(SHOTS, '07-github-help.png') });
    await page.getByRole('button', { name: 'OK, I’ll do that' }).click();

    // --- a plain folder can be adopted
    await page.getByTestId('add-project').click();
    await page.locator('.modal label', { hasText: 'notes' }).locator('input').check();
    await page.getByTestId('add-picked').click();
    await expect(page.getByTestId('project-title')).toHaveText('notes');
    await page.getByTestId('act-init').click();
    await closeLesson(page, 'This folder is now watched');
    // 55 + 5 (time machine tip) + 35 (first undo) + 5 (tip) + 45 (first init) + 5 (tip) = 150 → level 3
    await expect(page.getByTestId('levelup')).toContainText('Level 3');
    await page.getByRole('button', { name: 'Yay! 🎉' }).click();
    await expect(bubble(page)).toContainText('watching this folder now');
    expect(fs.existsSync(path.join(sb.projects, 'notes', '.git'))).toBe(true);

    // --- every tip is re-readable
    await page.getByTestId('nav-lessons').click();
    await expect(page.locator('.lesson-grid .card')).toHaveCount(12);
    await page.screenshot({ path: path.join(SHOTS, '08-tips.png') });
  } finally {
    await app.close();
  }
});

test('state survives a restart and a detached project is rescued', async () => {
  const sb = sandbox();
  let { app, page } = await launch(sb);
  await page.getByTestId('ob-start').click();
  await page.getByTestId('ob-name').fill('Ana');
  await page.getByTestId('ob-name-next').click();
  await page.getByTestId('ob-add').click();
  await expect(bubble(page)).toContainText('Welcome, Ana!');
  await app.close();

  // Something (maybe Claude) leaves the repo looking at an old save point with work on top
  fs.appendFileSync(path.join(sb.garden, 'poem.txt'), 'line two\n');
  g(sb.garden, '-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-qam', 'two');
  g(sb.garden, 'checkout', '-q', 'HEAD~1');
  fs.writeFileSync(path.join(sb.garden, 'idea.txt'), 'precious idea');

  ({ app, page } = await launch(sb));
  try {
    await expect(page.getByText('Hi, I’m Twig!')).toHaveCount(0);
    await expect(page.getByTestId('nav-project')).toContainText('Needs a hand');
    await page.getByTestId('nav-project').click();
    await expect(bubble(page)).toContainText('You’re looking at an old save point');
    await expect(page.locator('.main svg.twig').first()).toHaveClass(/mood-worried/);
    await page.screenshot({ path: path.join(SHOTS, '09-needs-help.png') });
    await page.getByTestId('act-rescue').click();
    await expect(bubble(page)).toContainText('All fixed!');
    expect(g(sb.garden, 'branch', '--show-current').trim()).toBe('main');
    const rescued = g(sb.garden, 'branch', '--list', 'rescued-work-*').trim().replace(/^\*?\s*/, '');
    expect(g(sb.garden, 'show', `${rescued}:idea.txt`)).toBe('precious idea');
  } finally {
    await app.close();
  }
});
