# Cohand

**Your browser. Every profile. Any agent.**

A Chrome extension and a local CLI that let AI coding agents work in your real, logged-in Chrome, across all your profiles, with many agents at once.

[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE) ![Platform: macOS · Linux](https://img.shields.io/badge/platform-macOS%20%C2%B7%20Linux-lightgrey.svg) ![Chrome](https://img.shields.io/badge/browser-Chrome-4285F4.svg)

You don't live in one browser profile. There's work, personal, a client or two, the side project. Your agents shouldn't be stuck in one either.

Cohand lets any coding agent (Claude Code, Codex, opencode, pi, Grok, or a plain shell script) work inside the Chrome you already use, **in whichever profile you're in.** Switch windows and new sessions follow you. Run three agents in your work profile and one in personal, and each stays in its own tab group, out of each other's way and out of yours. They use your real logins, cookies and extensions, with no headless copy or cloud browser, and you can watch every click as it happens.

```
cohand session start research
cohand open https://news.ycombinator.com
cohand snapshot          # the page as text, with clickable refs like [e12]
cohand click e12
```

---

## Why Cohand

Agents are great at deciding what to do in a browser. They're bad at getting into one. Headless browsers get stopped by logins, 2FA and bot checks. Cloud browsers need your passwords. Screen-scraping your desktop is slow and fragile.

Cohand takes a simpler route: **you're already logged in, so let the agent work next to you.** It's a small local daemon plus a Chrome extension. Nothing leaves your machine, and there are no accounts or API keys.

## What works today

These are in daily use and solid:

- **Any profile, automatically.** Load the extension into as many profiles as you like. A new session starts in whichever profile you're using right now, then stays pinned there even when you switch windows. You never have to pass a profile name (`--profile` exists if you want it).
- **Many agents, one browser.** Several agents can work in the same profile at once, or spread across different profiles, each in its own `🤖 name` tab group. They don't collide, and your own tabs are never touched.
- **Hand off with a drag.** Drag a tab into an agent's group to give it to that agent, or `adopt` a specific tab. Ending a session just ungroups the tabs; it never closes them.
- **Live status per profile.** The toolbar badge shows which profile is active (green), on standby (grey) or paused (red). The popup lists the agents working in that profile, each with a Stop button.
- **Your real logins.** Every site you're signed into just works: no re-login, no 2FA dance, no passwords handed to an agent.
- **Pages as text, not pixels.** `snapshot` turns a page into a compact accessibility tree with refs (`[e12]`). Agents act on refs, which is cheaper and more exact than reading screenshots.
- **Real input.** Clicks and keystrokes go through Chrome's debugger protocol, so React and other framework inputs register properly. Typing is checked and retried when needed.
- **You can see it work.** A soft glow and a ghost cursor show what the agent is doing. They stay out of screenshots.
- **Sessions that survive.** Sessions persist across daemon restarts and Chrome service-worker sleep, so a task can pause between chat turns and pick up where it left off.
- **Guardrails on by default.** Banks, payment pages, password managers and Google account security pages are blocked. Password fields are refused. Cookie *values* are never exposed.
- **Everything logged, privately.** Every action is written to a local log (`cohand log`). Typed text and scripts are stored as length only, and URLs drop their query strings.
- **One-command install.** It wires up the daemon (launchd / systemd / tmux) and the native-messaging host, and installs the agent skill for Claude Code, Codex, opencode, pi and Grok.

## Install

Requirements: **macOS or Linux**, **Chrome**, and **Node.js** (tested on Node 24).

```bash
git clone https://github.com/cohandhq/cohand.git
cd cohand
npm install
node cli/cohand.mjs install
```

Then, in each Chrome profile you want agents to use:

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick the `extension` folder.
3. Name the profile in the Cohand popup.

Check that everything is green:

```bash
cohand doctor
```

Full details: [docs/INSTALL.md](docs/INSTALL.md).

## Using it

Tell your agent *"use the cohand skill"*, or just give it a browser task. The skill teaches it the rest. The core commands:

| Command | What it does |
|---|---|
| `cohand session start <name>` | Start a session in the profile you're using |
| `cohand session resume <id>` | Pick a paused session back up |
| `cohand open <url>` | Open a tab in the agent's group |
| `cohand snapshot` / `find "<words>"` / `text` | Read the page |
| `cohand click e12` · `type e5 "hi"` · `key Enter` · `select` · `scroll` · `wait --text "Saved"` | Act on the page |
| `cohand screenshot` | Visual check (prints a file path and the device scale) |
| `cohand adopt <tabId> --any-tab` | Pull one of your tabs into the agent's group |
| `cohand session end` | Finish. Tabs are ungrouped, never closed |
| `cohand log` · `doctor` · `policy` · `profiles` | Inspect and configure |

## How it works

```
 agent ──► cohand CLI ──► cohandd (local daemon, policy + log)
                              │  unix socket
                              ▼
                      native-messaging host
                              │
                              ▼
                 Cohand extension (one per Chrome profile)
                              │  chrome.* APIs + debugger protocol
                              ▼
                     the agent's tab group
```

- **`cli/`**: the `cohand` command.
- **`daemon/`**: routes commands to the right profile, enforces policy, writes the log.
- **`host/`**: the native-messaging bridge between Chrome and the daemon.
- **`extension/`**: runs commands in the page (snapshot, click, type, overlay).
- **`skill/`**: the instructions installed into each agent.

## Safety model

Cohand acts with **your** logins, so treat it like handing someone your keyboard:

- **Approval prompts are off by default.** Agents can submit forms, upload files and run page scripts without asking. Turn on ask-first in `~/.cohand/policy.json` if you want an Allow / Deny prompt for risky actions.
- **Pause anytime** from the toolbar popup, per profile or everywhere. You can also block any site from the popup.
- Everything runs on your machine. Cohand has no server and sends no telemetry.

## Limitations

- **macOS and Linux only.** Windows isn't supported yet.
- **Chrome only.** Other Chromium browsers may work but are untested.
- **Not on the Chrome Web Store.** You load it unpacked.
- **Some single-page apps read poorly.** Snapshots can miss main content; screenshots are the fallback.
- **Clicks can occasionally hang** until the timeout, even when they landed.

The full, honest list: [docs/ISSUES.md](docs/ISSUES.md).

## Roadmap

- Reliable clicks: fail fast, never double-fire, and confirm navigation
- Better reading of heavy single-page apps and background tabs
- Contract tests for the extension layer
- Windows support
- A Chrome Web Store release with a trimmed permission set

## Contributing

Contributions are very welcome, whether it's bug reports, fixes or new commands.

1. Pick something from [docs/ISSUES.md](docs/ISSUES.md) or open an issue.
2. `npm install && npm test` (Node's built-in test runner, no browser needed).
3. After changing the extension, reload it in `chrome://extensions`. After changing `skill/SKILL.md`, re-run `cohand install`.
4. Open a pull request with a short note on what you changed and how you checked it.

Good first contributions: extension routing tests, the click-reliability items, and `--help` handling in `install` / `doctor`.

## License

[Apache 2.0](LICENSE). Use it, fork it, ship it, commercially or not.
