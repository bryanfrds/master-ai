# Master AI

A local dashboard for selecting cached ChatGPT logins used by Codex CLI in Ghostty, WezTerm, and other terminals, and for running coding agents in parallel. Node 22+ and the `codex` command are required. No dependencies or API key needed.

Run `npm start` in this directory, then open http://127.0.0.1:4783.

1. Click **Save current login** to retain your existing account.
2. Click **Add account** and complete OpenAI sign-in with another account. This uses an isolated temporary Codex home and leaves the current terminal login alone.
3. Exit running Codex sessions, then click **Use this account**. Run `codex` again in your terminal.

This switches the cached credentials; it does not type passwords or bypass MFA, account limits, or expired/revoked sessions. Add the same account again if OpenAI requires reauthentication. It does not change browser sessions. Existing Codex processes may retain or rewrite old credentials, so finish/exit those processes before switching. There is no promise of switching an in-flight conversation. To resume local work, use Codex's normal resume workflow after restarting.

Account credentials are stored in `~/.local/share/codex-account-dashboard` (directory mode 0700, files 0600). They are sensitive login tokens, not encrypted by this app. The outgoing account's newest credentials are saved before a switch and `previous-auth.backup` retains the previous login. The selected account is atomically written to `~/.codex/auth.json`. Never commit or share these files. No tokens are returned to the dashboard except the temporary OpenAI authorization URL and a local CSRF token.

The server binds only to 127.0.0.1, checks Host and Origin, and requires an unpredictable token for mutations. Do not expose it through a public tunnel or reverse proxy. It blocks keyring/auto credential configurations and explicit account restrictions in config.toml. Managed environments and process-level authentication overrides may not use the selected file.

`DASHBOARD_PORT` changes the port. `DASHBOARD_DATA_DIR` changes the private storage directory. `DASHBOARD_CODEX_BIN` selects the CLI executable. An existing `CODEX_HOME` is respected. Tests use temporary synthetic credentials and never switch your real login.

Authentication reference: https://learn.chatgpt.com/docs/auth

When an account's remaining usage first reaches zero, the Accounts tab says so and plays a sound. It fires on the change, not repeatedly while the account stays empty, and the checkbox beside **Refresh usage** turns it off. Browsers block audio until the page has been clicked once, so the very first alert of a session may be silent. Usage is only polled on the Accounts tab, so that tab has to be open to hear it.

Each agent login also shows that agent's plan limits, where it has any to show. Codex reports them live. Claude Code keeps its own in its configuration and the card says the reading is as of when Claude Code last ran — there is no command that reports them, and starting a session to ask would spend some of the very thing being measured. Devin and Hermes report no limits at all, and their cards say that rather than leaving a gap.

**Agent logins** lists who each agent is signed in as — Claude Code, Codex, Devin, and Hermes — so the whole set is visible without running four terminal commands. It is read-only apart from Codex: the other three are managed by their own CLIs (`claude`, `devin auth login`, `hermes auth add`). Identities are shown, never credentials; anything key-shaped is stripped before it reaches the page. The check runs in the background at most once a minute, and **Refresh logins** forces it.

**Remove** on a saved account deletes its copy from this computer; click it twice, since the second click is the confirmation. It does not sign the account out of ChatGPT, and it does not log out your terminal: removing the account you are currently using leaves the credentials in the Codex home alone, so Codex keeps working until you switch. Sign in again any time to add it back.

## Remaining usage

Shows remaining percentages, quota window lengths, reset times in your timezone, and the last successful check. OpenAI may return multiple model-specific buckets. Updates every minute while the page is open; Refresh usage checks at most once per 30 seconds. These are quota percentages, not remaining prompt counts.

Checks use Codex app-server with an isolated home and experimental external-token auth. They do not switch accounts, start model turns, or rotate refresh tokens. Expired logins, unsupported CLI versions, and network errors show as unavailable; older results are marked last known. Use the account in Codex or add it again if it needs a fresh login.

## Agents

The **Agents** tab runs coding agents on a project and shows what each one is doing, so several can work at once without watching separate terminal tabs. It drives whichever of these CLIs you have installed and signed in: **Claude Code**, **Codex**, **Devin**, and **Hermes**.

The Agents tab opens with a row naming what each agent is for, the same description appears under the agent picker, and every proposed task shows the role of whoever it is assigned to. These are the descriptions the planner is given: Claude Code for frontend, general coding and any writing the repo needs, Codex for backend and API work, Devin for testing and UI design. These are hints, not rules — you can reassign any task before starting it, and start any agent on anything yourself.

Claude Code and Codex report each step they take, so their output shows the tools they ran and the files they touched. Devin and Hermes print prose rather than events, so their runs show text and the file counts, without a step-by-step trace.

### Handing over the whole job

**Hand Claude the whole job** takes a goal and a project folder, and Claude reads the project and proposes as few tasks as the goal honestly needs — one, if one agent should just do it — choosing an agent for each and saying in a line why that agent for that task. The descriptions the planner is given are tendencies rather than rules, so it can go against the usual split when a job calls for it, and the same agent can take more than one task. Changing the agent on a task replaces the reason with that agent's own description, so it is clear you have overruled the choice. It changes nothing: you get a list you can edit. Change the agent, rewrite the instructions, change what each task waits for, or drop a task, then **Start all**. Planning takes about a minute of model time and is billed to your Claude Code account like any other run.

A task set to run **after** another does not start until that one finishes, and its worktree branches from that run's commit rather than from your project's tip — so the agent writing tests sees the backend the previous agent just wrote. If a run fails or is stopped, everything queued behind it is marked skipped rather than run against work that does not exist. A waiting task can be cancelled before it starts.

### Project keys

Agents work in a git worktree, which holds only the files git tracks — so a `.env` sitting in your project is invisible to them, and shell exports do not reach an app started from Finder either. **Project keys**, under the task box, is where that gets solved: type a name and a value once per project folder.

Every agent working on that folder then gets those keys twice over — as environment variables, and as a `.env` written into its worktree for code that reads one. A `.env` the project tracks itself is never overwritten; yours wins.

The keys file is deleted before anything is staged, so it cannot be committed to a branch or merged into your project. Values are stored in `~/.local/share/codex-account-dashboard/secrets` (directory 0700, files 0600), named by a hash of the project path rather than the path itself. A saved value never comes back to the page: the dashboard shows the name and a few characters at each end, enough to recognise a key and not enough to use one.

Agents can read anything you save here, and can quote it in their own output. Save only what you would let an agent see.

### Starting one yourself

The project folder sits at the top of the tab and is used by everything on it: planning, starting an agent yourself, and the keys given to them. Choose an agent and a task. Each run gets its own git worktree on a new `agents/<agent>-<id>` branch, so two agents never write over each other and your own checkout is untouched. When a run ends, whatever it changed is committed to that branch; the card shows the commit.

Open a finished run and switch to **Changes** to read its diff — only what that run did, so a task that followed another shows its own work rather than repeating the work it built on. **Keep it** first checks that the work stands up, then merges the branch into whichever branch your project is currently on, with a merge commit.

The check runs the project's own `build` and test scripts, read from its `package.json`, inside the worktree the agent worked in — so what is checked is what would be merged. A test script that watches for changes never exits, so `test:run` or `test:ci` is preferred over a bare `test` when the project has one. If either fails the merge is refused and the last few lines of the failure are shown; the button then offers to merge anyway, because a build can be broken for reasons that predate the run. A project with no scripts, or one whose dependencies the agent never installed, cannot be checked and is not held up by it. When several runs are waiting, **Keep all** at the top checks and merges them in the order they started, and stops at the first refusal rather than half-applying. A branch whose work is already in the project — because a later run was chained onto it — is recognised as merged rather than treated as a conflict. Merging is local: nothing is pushed. **Push** appears beside it when the branch has commits its upstream does not, and says how many. It asks twice, because on a branch that deploys this is the step that changes what is live — the first click arms it and says what it will send, the second sends it. A branch with no upstream, or nothing to send, is refused rather than guessed at.

When a run finishes, the Mac app raises a notification saying what changed; clicking it brings the window back. If notifications are turned off for the app it bounces the Dock icon instead, and says so once. macOS only ever asks for permission the first time, so the app menu carries **Notification Settings…** to open the right pane and **Send a Test Notification** to check it from there; permission granted while the app is running is picked up without a restart.

A notification marks a change the page sees: if a run had already finished before the page was opened, there is nothing to announce. In a browser there is no notification, only the message on the page. **Throw away** deletes the branch and its work, and asks once before it does.

A merge is refused rather than forced in the two cases where it could cost you something: if your project has uncommitted changes, so a merge cannot bury work in progress; and if the merge conflicts, in which case it is aborted and the project is left exactly as it was for you to merge by hand. Removing a run without throwing it away keeps the branch, as before. **Remove finished** at the top clears every run that has stopped in one go, and says how much it freed; runs still working are left alone, and every branch is kept, so nothing is lost by tidying up.

Worktrees are the bulk of what a run holds: one that installed dependencies to run the project's tests can be hundreds of megabytes. A run holding more than about 20 MB says so on its card, so the space is visible rather than discovered later. Committing needs `user.name` and `user.email` set in git — without them the work stays in the worktree and the card says so. Removing a run deletes its worktree but leaves the branch.

Uncheck **Own git branch** to work directly in the folder instead, which is the only option for a folder that is not a git repository. Nothing is committed in that mode: the agent's changes sit in your working tree next to your own, exactly as if you had run it in a terminal.

Agents may edit files inside their worktree without asking, and may run commands there. **Read only** starts them in a mode that does not change anything: `plan` for Claude Code, the `read-only` sandbox for Codex, `auto` for Devin, and `--safe-mode` for Hermes.

Hermes is not offered to the planner at all — it is a personal assistant for messages and errands rather than repo work, so it is chosen deliberately or not at all, and a plan naming it is redirected to Claude. It is the exception worth knowing about in another way too: it has no middle setting between asking about every command and `--yolo`, and nothing can answer a prompt in a non-interactive run, so its normal mode bypasses command approval. Its worktree is the only boundary. Prefer **Read only** for Hermes unless you want that. Nothing here bypasses an agent's own approval settings, and no full-access mode is offered. Only start tasks you would be willing to run in a terminal yourself.

While anything is working, a bar above the cards shows how many of the batch have finished, who is working, and how many are queued, with a small figure running laps along it. The runner is drawn in the page rather than loaded, so it costs nothing and takes the page's own colours; it holds still for anyone who has asked the system to reduce motion.

To use a picture of your own instead, put it in `~/.local/share/codex-account-dashboard` named `runner.png`, `runner.gif`, `runner.webp` or `runner.jpg` — an animated GIF works. It is read from there rather than shipped with the app, and if it fails to load the drawn one stays. Runs are grouped by the project they belong to, since several projects can be worked on at once: each group is headed by the folder's name with how many runs it holds and how many are working, and the folder currently in the box is listed first. Each card shows status, the newest line of output, the branch, and how many files and lines changed. The task itself is trimmed to two lines, with **Show the whole task** to read the rest — agent instructions run to hundreds of words and a wall of them tells you nothing at a glance.

Picking a run up again replaces its card rather than adding one beside it: the older attempt is folded away, the current one is tagged with which attempt it is, and **Show earlier attempts** brings the previous ones back when you want them. Selecting a run shows its output, refreshed every second. Once everything has settled, **What was done** appears above the cards: one line per run saying what it was asked for and what it changed, followed by the agent's own closing account of itself, and a total at the bottom of how much changed and how much is still waiting to be kept. **Copy** puts the same thing on the clipboard as Markdown. The account itself is written in plain English by a small fast model (Claude Haiku) from what the runs recorded and what the agents said — agents close with release notes full of code, SQL and file paths, which is accurate and unreadable. It ends with a line saying what is left for a person to do. **Show the details** reveals the per-run figures and each agent's own words, stripped of code blocks, absolute paths and markdown.

That is one small model call per batch, cached so it is not redone while nothing changes. If it cannot be written, the panel says why — a usage limit, a timeout — rather than only that there is none, and the figures and the agents' own words are still there. Merging does not throw it away: what the agents did is not changed by keeping it, so the account is written once per batch rather than again after every merge.

It appears only when nothing is still working, since a summary of half a batch says little.

Runs do not survive restarting the dashboard or quitting the app: agents are its child processes and stop with it. Quitting while any are working asks first, and says how many.

What an interrupted run had already written is not lost. On the next start, its worktree is committed to its branch, so the work can be read, merged, or built on like any other run. Any run that stopped early offers to be picked up again. One that got some way through says **Continue**: the same task on a branch starting from what was salvaged, with instructions to carry on rather than begin again. One that never started says **Run it again**, and simply runs.

Either way the rest of the chain comes with it. Anything that was queued behind the run is started again too, in order, following the revived run — so a chain broken by a restart takes one click to resume rather than one per task. A revived run follows whatever now stands for the run it was originally waiting on, so it builds on the newest work rather than the abandoned attempt. A run that has already been picked up says so and is not offered again.

Each agent card on the Agents tab has a model box showing what that agent will actually use, read from its own configuration — Claude Code's settings, Codex's `config.toml`, Hermes's `config.yaml`. Leave it as it stands and nothing changes; type a name and every run of that agent uses that instead. Devin keeps no model in its configuration, so it shows the agent default until you set one or a run reports what it used. Beside it is a reasoning level. Each agent names its own, because they do not agree: Claude Code takes low to max, Codex minimal to high, Hermes none to ultra. Devin has no such setting at all — the level is part of its model name, so choosing one there only works alongside a model, and the card says so. The line under the box says which model will be used and where that came from — set here, the agent's own config, or its default — so it is never a guess.

Suggestions are offered where the CLI can list them: Devin's model families and aliases come from `devin models list`, and Claude Code's are its own `opus`, `sonnet` and `haiku`. Codex and Hermes take a typed name. A name is checked before it reaches a command line: letters, numbers and `. _ : / -` only.

Codex runs otherwise use the model set in your own `~/.codex/config.toml` — `model` and `model_reasoning_effort` — and the Agents tab shows which one that is, next to Codex. Runs that use a saved account get a copy of that same config, so both paths agree. Change the model in that file and the dashboard follows; nothing is pinned here to go stale.

A Codex run can use any saved account rather than the current terminal login, which spreads work across separate usage limits. The run gets a private `CODEX_HOME`, so starting it does not change which account your terminals use, and any credentials Codex refreshes during the run are saved back. Claude Code always uses its own login.

Runs are stored in `~/.local/share/codex-agent-runs` (directory mode 0700), one directory per run holding its metadata, its output log, and its worktree. `DASHBOARD_RUNS_DIR` changes the location. `DASHBOARD_CLAUDE_BIN`, `DASHBOARD_DEVIN_BIN`, and `DASHBOARD_HERMES_BIN` select those executables. Delete a run from the dashboard to remove its directory.

Agent output is read from `codex exec --json`, `claude --print --output-format stream-json`, `devin --print`, and `hermes --oneshot`. Output that a future CLI version formats differently is shown as raw text rather than dropped.

## Mac app

`npm run app` builds **Master AI.app** into `/Applications` (or `~/Applications` if that is not writable). It is a real app: its own window, its own icon in the Dock, no browser tab and no address bar. Opening it starts the dashboard and shows the Agents tab; quitting it stops the dashboard. Opening it again while it is running brings the window back. Pass a directory to install it somewhere else: `npm run app -- ~/Applications`.

Inside the app, **Choose…** next to Project folder opens a normal macOS folder picker, so you can pick a project instead of typing its path. In a browser that button is hidden and the text field is the only way in.

Sign-in and other outside links open in your real browser, which is where your session and password manager live. The dashboard itself stays in the window.

Node 22+ must still be installed. The app bundles the dashboard, not a Node runtime, and finds `node` by asking a login shell, since Finder starts apps with almost no `PATH`. If Node is missing or the dashboard fails to start, the app says so and writes the reason to `~/Library/Logs/Master AI.log`.

The dashboard files are copied into the app, so it keeps working if this folder moves. Run `npm run app` again after changing the code; a running app keeps the old copy until you rebuild and reopen it.

Building needs the Xcode Command Line Tools (`xcode-select --install`) because the window is compiled from `app.swift`; running the built app does not. macOS will not launch an app whose executable is a script, which is why this is a compiled binary rather than a wrapper. The app is signed ad hoc: built on your own machine it opens with a double-click, but a copy sent to another Mac is quarantined and needs one right-click, Open, first.

## Other computers

Targets: macOS, Linux, and Windows through WSL (install both Codex and the dashboard inside the same WSL distribution). Native Windows is not supported. Only macOS has been tested on a real computer.

Install Node.js 22+ and Codex CLI. Transfer the installer from the dashboard's Download installer package link to the other computer, then run in its download directory:

```sh
npm install -g ./codex-account-dashboard-1.1.0.tgz
codex-accounts
```

The command starts the dashboard and attempts to open the browser. If it doesn't open, visit the printed localhost URL manually. `codex-accounts --no-open` skips browser opening. Keep its terminal open; Ctrl+C stops it.

Sign into each account once per computer. The installer includes only application code and public assets, never credentials. Accounts and the selected login are local, not synchronized. Reuse the original installer to transfer the application onward; installed copies don't include a second installer download.

To create a new package, create a `dist` directory and run `npm pack --pack-destination dist`. The package file allowlist excludes credentials, tests, and build archives.

Usage API reference: https://learn.chatgpt.com/docs/app-server
