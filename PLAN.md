# kmGitBot — Plan

Goal (from the user): a desktop bot that monitors your git and Claude sessions and handles git
for people who don't know git. It is friendly and teaches gently while it works. Its mascot is
cute and levels up. The interface is approachable for people who've never used git. Models for
the work are my call, capped at Opus 5.5. Done means: the tests pass and the app is live.

Process: draft v0 → 10 passes of evaluate → enhance/refine → final plan → build.

---

## v0 — first draft

**Stack:** Electron desktop app (HTML/CSS/SVG gives the cutest, most animatable mascot) + plain
Node for the core logic. The core has no Electron imports so the tests can run it directly.

**Core modules (`src/core/`)**
- `git.js` – runs `git` with `execFile` (no shell): status, commit, push, pull, log, init.
- `explain.js` – turns git status/errors into plain English.
- `claudeWatcher.js` – watches `~/.claude/projects/*/*.jsonl`, reports active sessions.
- `mascot.js` – XP and levels.
- `store.js` – JSON settings/state in the app's user-data folder.

**UI:** one window. Project list on the left, mascot + big friendly buttons on the right:
"Save my work", "Send to GitHub", "Get latest", "History".

**Tests:** node:test unit tests against temp git repos; Playwright e2e that launches Electron.

**Live:** `npm start`, plus a `.desktop` launcher.

---

## Pass 1 — evaluate against the user's words

Scorecard (1–5): monitors git 3 · monitors Claude 2 · handles git for non-git users 3 ·
teaches gently 1 · cute mascot 2 · levels up 2 · approachable UI 3 · models decided 0 ·
tests 3 · live 3.

Gaps: "teaches gently" has no mechanism at all. The mascot has no name, look, or personality.
"Monitors Claude sessions" only lists sessions — it doesn't *do* anything with them. No model
decisions.

Refinements:
- **Teaching layer.** Every action ends with a small "What just happened?" bubble: one
  sentence in plain words, then the real git word ("This is called a *commit*"), then an
  optional "Show me the command" reveal with the literal `git ...` line. Never a lecture —
  one idea per bubble, dismissable, and the same lesson isn't repeated after it's been seen twice.
- **Mascot: Twig**, a small sprout creature. The metaphor carries the teaching: git has
  *branches*, *trees*, and *roots*, so Twig literally grows. Stages: Seed → Sprout → Sapling →
  Young Tree → Grand Oak. Big eyes, blinking, soft sway.
- **Claude sessions become useful:** when Claude has been editing files in a project, Twig
  suggests "Claude changed 6 files in *kmGitBot* — want a save point so you can undo if
  needed?" That's the core value: a safety net under AI edits.

## Pass 2 — evaluate the safety story (the users can't recover from git mistakes)

Gap: a non-git user who hits a merge conflict, detached HEAD, or a rejected push is stranded.
v0 wraps commands but doesn't guard against harm.

Refinements:
- **Never-destroy rule.** The app never runs `reset --hard`, `push --force`, `clean`,
  `checkout -- <file>` without a backup, or `branch -D`. Undo goes through `git revert`
  (new save point that reverses an old one) or restoring a file from a save point after first
  stashing the current version under a labelled backup.
- **Pre-flight checks** before every operation: is this a repo, is there a merge/rebase in
  progress, is HEAD detached, is there a remote, is there an upstream.
- **Pull is `--ff-only` first.** If that fails (diverged), fall back to `pull --no-rebase`; if
  a conflict appears, abort the merge automatically, leave the files untouched, and explain:
  "You and GitHub both changed the same thing. Nothing was lost. Here are your choices…"
- **Error translator** in `explain.js`: known git stderr patterns → friendly message + next
  step (auth failed, no upstream, non-fast-forward, not a repo, nothing to commit, identity
  not set, index.lock exists).

## Pass 3 — evaluate the vocabulary and screen flow

Gap: button labels in v0 still leak git words ("pull", "push", "branch"). Also no first-run.

Refinements — plain-word glossary used everywhere in the UI (git word taught *after*):

| UI says | Git word taught |
|---|---|
| Save point | commit |
| Save my work | stage + commit |
| Send to GitHub / Back up online | push |
| Get the latest | pull |
| Time machine | log / history |
| Undo that save point | revert |
| Bring back a file | restore |
| Start watching this folder | init |
| Try an idea safely (Experiment) | branch |

- **First-run welcome:** Twig hatches from a seed, asks the user's name, and offers to find
  projects automatically (scan `~/aiProjects` and folders Claude has worked in).
- **Projects screen:** one card per project with a traffic-light mood: green "All saved",
  yellow "3 unsaved changes", blue "2 save points not backed up", red "needs help".
- **Project screen:** mascot bubble on top, big primary button (whatever is most useful now),
  secondary buttons, list of changed files in plain words ("✏️ edited README.md",
  "✨ new file notes.txt", "🗑️ deleted old.js").

## Pass 4 — evaluate leveling (is it fun, or just a number?)

Gap: XP with no rhythm isn't motivating, and rewarding raw volume encourages junk commits.

Refinements:
- XP table: save point +10 (max 6/hour count), backup online +15, get latest +5, first time
  doing any action +25 ("First backup!" badge), reading a lesson +5, resolving a "needs help"
  +30, daily streak +10 per day.
- Level curve: `xpForLevel(n) = 50·n·(n+1)/2` (50, 150, 300, 500 …). Growth stage every
  3 levels up to Grand Oak at 13.
- Level-ups unlock things: new accessory for Twig (leaf hat, scarf, tiny glasses, flower,
  crown of leaves), and the next lesson in the "Git garden" path (branches unlock at level 4,
  tags at 7…). Leveling *is* the curriculum.
- Moods drive animation: happy (idle), curious (Claude active), worried (unsaved for a long
  time / conflict), proud (level up, confetti leaves), sleepy (night, no activity).

## Pass 5 — independent critique (Sonnet 5 reviewer, read-only)

Its findings and what I did with each:

| Finding | Decision |
|---|---|
| Saving while Claude is mid-edit can capture a half-written file | **Accept.** If the watcher saw activity in that folder in the last 20 s, "Save" waits: Twig says "Claude is still typing — I'll save when it pauses." The user can override. Tested. |
| Session-log `cwd` is untrusted input | **Accept.** Paths are `realpath`'d, must be absolute, must not start with `-`, must be ≤ 4096 chars, and must be an existing dir. They're only ever used as `cwd`, never put into argv. Tested with hostile lines. |
| First push with no GitHub auth / no remote is the #1 real-world failure | **Accept.** "Back up online" checks for a remote first. No remote + `gh` logged in → offer "Make a private GitHub home for this project" (`gh repo create <name> --private --source . --push`), only after the user confirms. No `gh` auth → a guided card explaining how to run `gh auth login` in plain words. |
| Tail JSONL files incrementally | **Accept.** Per-file byte offsets, only new bytes read, partial lines buffered, first read capped to the last 512 KB. |
| No git identity on a fresh machine | **Accept.** Onboarding asks for a name (email optional). If git has no identity, commits pass `-c user.name=… -c user.email=…`; global config is never touched. |
| Files > 100 MB break GitHub pushes | **Accept.** Pre-save guardian: files over 95 MB aren't included; Twig explains why and offers to add them to `.gitignore`. Same flow for secrets (`.env`, `*.pem`, `id_rsa`, …). |
| Offline | **Accept (small).** Network errors become "Looks like you're offline — nothing is lost, your save points are safe on this computer." No retry queue in v1. |
| Cut level-gated curriculum, accessories, streaks, Experiment button | **Accept.** Lessons become a flat, re-readable list, shown in context after an action. Growth stages are the only visual reward. No streak XP. Branches are taught as a lesson, not a button. |
| Colour-only status | **Accept.** Every state has an icon and words as well as a colour. |
| "Seen twice" lessons can't be re-read | **Accept.** Lessons page lists every lesson; seen ones can be replayed. Settings has "Show tips again". |
| No scary words in confirmations | **Accept.** Style rule: UI never says force, hard, reset, abort, fatal, HEAD, or detached. |
| Detached HEAD, index.lock | **Accept.** Detached HEAD → "needs help" card with a one-click "Go back to your main line" (`git switch <default>` only if no changes; otherwise save to a rescue line first). A stale `index.lock` (older than 10 min, no git process running) → offer to clear it. |

## Pass 6 — evaluate architecture and security

Scorecard: most features now have a home, but the process boundary and concurrency model are
unstated.

Refinements:
- **Electron hardening:** `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`,
  strict CSP (`default-src 'self'`), no remote content, `setWindowOpenHandler` denies all,
  navigation blocked. The preload exposes one `window.kmgit` object with named methods only.
- **The renderer never sends a path.** It sends a project id; main looks the path up in the
  store. New projects come only from the native folder picker or from discovery in main.
- **Git runner:** `execFile('git', args, { cwd, env })` with `GIT_TERMINAL_PROMPT=0` (push can
  never hang waiting for a password), `LC_ALL=C` (stable stderr to translate), `GIT_OPTIONAL_LOCKS=0`
  for background status polling, 60 s timeout, 20 MB buffer. Status uses
  `status --porcelain=v2 --branch -z`.
- **One operation at a time per repo** (promise queue keyed by path) — no self-inflicted
  `index.lock` races.
- **Polling, not recursive fs.watch** (inotify limits on big repos): repo status every 5 s for
  visible projects, 20 s otherwise; Claude dir scan every 3 s.
- **Store:** `state.json` in the user-data dir, written atomically (tmp + rename), schema
  version, corrupt file → backed up and replaced with defaults. `KMGIT_HOME` and
  `KMGIT_CLAUDE_DIR` env vars override locations (this is what makes e2e tests hermetic).
- **Single-instance lock**; closing the window hides it to the tray.

## Pass 7 — evaluate models and agents (cap: Opus 5.5)

**Inside the app** (optional; everything works without it):
- **Haiku 4.5** writes the save-point message from the diff (diffstat + first 8 KB of diff).
  Fast (~3 s measured) and cheap, and a commit message is a small, low-stakes job.
- **Sonnet 5** explains a save point or a "needs help" situation in plain words, on demand
  only ("Explain this to me" button). Better at gentle teaching; the latency is fine on demand.
- Invoked through the already-logged-in `claude` CLI: `claude -p --model <alias>
  --no-session-persistence --tools ""`, run from a scratch dir. No API key needed, no session
  logs created, no tools — it can only return text.
- `ai.js` has a hard allowlist `{haiku, sonnet}`; anything else throws. That enforces the
  Opus 5.5 ceiling in code, not just in the plan. Tested.
- Fallback: deterministic messages ("Update README.md and 2 other files"), used when the CLI
  is missing, slow (> 25 s), or AI is switched off in Settings. Settings says plainly that
  AI mode sends the diff to Claude.

**Building it:**
- **Opus 5.5 (me)** — lead: architecture, core git safety code, UI, integration. The modules
  are tightly coupled through one IPC surface, so parallel writers would collide.
- **Sonnet 5** — independent reviewers: the plan critic (pass 5) and a code/safety review
  of the finished core before release.
- No Fable (above the cap). Haiku isn't needed for the build itself.

## Pass 8 — evaluate the testing strategy

"ab tests pass" I'm reading as *all tests pass*: `npm test` runs both suites and must be green.

- **Unit/integration (`node:test`, zero extra deps)** against real temp repos plus a local
  bare "GitHub" remote:
  - status parsing (new / edited / deleted / renamed / spaces and unicode in names)
  - save point with and without git identity; nothing-to-save
  - back up online: first push sets upstream; no remote → `needs-remote`; offline/auth
    errors translated
  - get latest: fast-forward; diverged-but-clean merge; **conflict → auto-abort → working
    tree byte-identical to before**
  - undo a save point (revert), bring back a file (backup stash made first)
  - detached HEAD → needs-help; stale `index.lock` → detected
  - guardian: secrets and > 95 MB files excluded (sparse file, so the test is fast)
  - Claude watcher: fixture JSONL, incremental appends, partial lines, malformed JSON,
    hostile `cwd` (leading `-`, relative, huge, nonexistent) ignored; edited files mapped
    to the right project; "Claude busy" window
  - mascot: XP curve, hourly save cap, first-time bonuses, level-up + stage events
  - store: atomic write, corrupt-file recovery
  - ai: model allowlist rejects opus/fable, fallback when the CLI is missing (fake binary)
  - explain: each known stderr pattern → friendly message; no banned words in any UI string
- **End-to-end (Playwright `_electron`)** with hermetic `KMGIT_HOME`/`KMGIT_CLAUDE_DIR` and
  AI disabled: onboarding → add a project → edit a file → "Save my work" → lesson bubble +
  XP gain → Time machine shows it → Undo → a fake Claude session appears in the Claude panel
  and triggers the nudge → level-up shows Twig's new stage. Screenshots saved for review.

## Pass 9 — evaluate "live" and daily life

- **Live** = installed and running on this desktop: `npm start` works, a `.desktop` launcher
  in `~/.local/share/applications` (shows in the KDE menu), a Twig icon, and the app launched
  and verified running at the end. Optional "Start when I log in" toggle writes
  `~/.config/autostart/kmgitbot.desktop`.
- **Tray** (KDE StatusNotifierItem works under Wayland): Twig face, menu with Open / Save all
  / Quit.
- **Notifications** only for things that matter (Claude finished changing files; lots of
  unsaved work for > 2 h; something needs help), max one per project per 30 min.
- **Dogfooding:** kmGitBot itself is a git repo with regular commits, and is added as the
  first project.

## Pass 10 — final evaluation, scope, build order

Final scorecard: monitors git 5 · monitors Claude 5 · handles git safely 5 · teaches gently 4
· cute mascot 4 · levels up 4 · approachable UI 4 · models decided 5 · tests 5 · live 5.
The 4s are the parts that can only be judged by looking at the running app — I'll screenshot
and iterate on them after the e2e run.

**v1 scope (in):** onboarding, project discovery (from `~/aiProjects` and Claude session
folders) + folder picker, "start watching this folder" (init with a friendly `.gitignore`),
status cards, Save my work (+ AI message), Back up online (+ GitHub home via `gh`), Get the
latest, Time machine, Undo a save point, Bring back a file, Claude sessions panel + nudges +
opt-in auto-save after Claude goes quiet, guardian (secrets/large files/Claude busy), lessons,
Twig with 5 growth stages and 5 moods, XP/levels, tray, notifications, settings.

**Out (v2):** branch/experiment button, accessories, streaks, tags, LFS, submodules.

**Build order**
1. `git init`, scaffold `package.json`, install `electron` + `@playwright/test`.
2. Core: `store`, `gitRunner`, `git`, `explain`, `guardian`, `mascot`, `lessons`,
   `claudeWatcher`, `ai`.
3. Unit tests green.
4. Electron `main`, `preload`, IPC, tray, notifications.
5. UI + Twig SVG.
6. E2E green; review screenshots; polish.
7. Sonnet 5 safety review → fixes → all tests green.
8. Icon, `.desktop`, launch, verify it's running.
