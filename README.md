# Twig (kmGitBot)

A friendly desktop helper that does git for you and keeps an eye on your Claude Code sessions.
Twig is a little sprout who saves, backs up and undoes things in plain words, teaches you one
git idea at a time, and grows from a Seed into a Grand Oak as you look after your work.

## Run it

```sh
npm install
npm start            # or launch "Twig" from the app menu
```

`scripts/twig` is the launcher used by the menu entry (`assets/kmgitbot.desktop`) and by the
"Start Twig when I log in" setting. Closing the window keeps Twig in the tray.

## What it does

| Twig says | Git does |
|---|---|
| Save my work | `git add -A` + `git commit` (secrets and files over 95 MB are kept out) |
| Back up online | `git push` (offers a private GitHub home via `gh` if there's none) |
| Get the latest | `fetch` + fast-forward or a clean merge; stops and puts everything back on a conflict |
| Time machine | `git log` |
| Undo this save point | `git revert` (history is never rewritten) |
| Bring back a file | `git stash` of your current version, then `git restore --source` |
| Fix it for me | leaves a detached HEAD safely, cancels half-finished merges after backing up files, clears stale locks |

Never run by the app, whatever happens: `reset --hard`, `push --force`, `clean`, `branch -D`, `checkout --`.

**Claude sessions:** Twig tails `~/.claude/projects/*/*.jsonl`, shows which projects Claude is
working in, waits for Claude to pause before saving, nudges you to make a save point when Claude
finishes, and explains git commands Claude runs. Optional: auto-save after Claude.

**AI help (optional):** uses your logged-in `claude` CLI. Haiku 4.5 writes save-point messages,
Sonnet 5 explains a save point when you ask. Only those two models are allowed in code
(`src/core/ai.js`). Turn it off in Settings.

## Tests

```sh
npm test             # unit (node:test, real temp repos) + end-to-end (Playwright driving Electron)
```

The plan and its 10 review passes are in [PLAN.md](PLAN.md).
