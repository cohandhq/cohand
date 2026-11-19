<p align="center"><img src="docs/assets/logo.png" alt="Cohand logo" width="96" height="96"></p>

<h1 align="center">Cohand</h1>

<p align="center"><b>Your browser. Every profile. Any agent.</b></p>

<p align="center">Browser automation for AI agents, without the headless browser.<br>Let your coding agents work in your real, logged-in Chrome: across all your profiles, many agents at once, while you watch.</p>

<p align="center">
<a href="https://www.npmjs.com/package/cohand"><img src="https://img.shields.io/npm/v/cohand.svg" alt="npm"></a>
<a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue.svg" alt="License: Apache 2.0"></a>
<img src="https://img.shields.io/badge/platform-macOS%20%C2%B7%20Linux-lightgrey.svg" alt="Platform: macOS · Linux">
<img src="https://img.shields.io/badge/browser-Chrome-4285F4.svg" alt="Chrome">
</p>

<p align="center"><b>Works with</b> Claude Code · Codex · Cursor · Gemini CLI · GitHub Copilot · opencode · Amp · Goose · Factory · Kiro · pi · Grok<br>and any tool that reads <a href="https://agentskills.io">Agent Skills</a></p>

<p align="center"><a href="#install">Install</a> · <a href="#features">Features</a> · <a href="#performance">Performance</a> · <a href="#how-it-works">How it works</a> · <a href="docs/ISSUES.md">Known issues</a></p>

```bash
npm install -g cohand && cohand install
```

---

## Why Cohand

You don't live in one browser profile. There's work, personal, a client or two, the side project. Your agents shouldn't be stuck in one either.

Agents are great at deciding what to do in a browser. They're bad at getting into one. Headless browsers get stopped by logins, 2FA and bot checks. Cloud browsers want your passwords. Screen-scraping your desktop is slow and fragile.

Cohand takes a simpler route: **you're already logged in, so let your agents work right next to you**, in every profile you have. It's a small local daemon plus a Chrome extension. Nothing leaves your machine, and there are no accounts or API keys.

## Highlights

<table>
<tr>
<td width="33%" valign="top"><h3>🧑‍💻 Every profile, at once</h3>Agents work in your Work, Personal and client profiles <b>at the same time</b>. Each session is pinned to its own profile, so nothing crosses over.</td>
<td width="33%" valign="top"><h3>🤝 Many agents, no collisions</h3>Run several agents side by side, even in the same profile. Each gets its own <code>🤖 name</code> tab group and never touches your tabs.</td>
<td width="33%" valign="top"><h3>🔑 Your real logins</h3>Every site you're signed into just works. No re-login, no 2FA dance, no passwords handed to an agent.</td>
</tr>
<tr>
<td valign="top"><h3>👀 Watch it work</h3>A soft glow and a ghost cursor show every move as it happens. Pause any profile, or stop any agent, in one click.</td>
<td valign="top"><h3>⚡ Fast and lean</h3>Reads a page in ~80 ms with no browser to launch. Snapshots are <b>about 5x smaller</b> than Playwright MCP's on the same page.</td>
<td valign="top"><h3>🧩 Any agent</h3>One install teaches Claude Code, Codex, Cursor, Gemini CLI, Copilot and more, through the open Agent Skills standard.</td>
</tr>
</table>

### Many agents, many profiles, one Chrome

```text
 Chrome
 ├─ Work profile ──────── 🤖 research    (Claude Code)
 │                        🤖 pr-review   (Codex)
 ├─ Personal profile ──── 🤖 bookings    (Cursor)
 └─ Client profile ────── 🤖 qa-check    (Gemini CLI)
                          ...your own tabs stay untouched
```

### Try it

```bash
cohand session start research
cohand open https://news.ycombinator.com
cohand snapshot          # the page as text, with clickable refs like [e12]
cohand click e12
```

## Features

**Profiles and agents**
- **Every profile, simultaneously.** Load the extension into as many Chrome profiles as you like, and run agents in all of them at the same time.
- **Follows you automatically.** A new session starts in whichever profile you're using right now, then stays pinned there even when you switch windows. No profile names needed (`--profile` exists if you want it).
- **Many agents per profile.** Each session gets its own `🤖 name` tab group, so agents never collide with each other or with you.
- **Hand off with a drag.** Drag a tab into an agent's group to give it to that agent, or `adopt` a specific tab. Ending a session ungroups the tabs; it never closes them.
- **Sessions that survive.** Sessions persist across daemon restarts and Chrome sleep, so a task can pause between chat turns and pick up where it left off.

**Reading and acting**
- **Pages as text, not pixels.** `snapshot` turns a page into a compact accessibility tree with refs (`[e12]`), so agents act on exact elements instead of guessing pixel positions.
- **Real input.** Clicks and keystrokes go through Chrome's debugger protocol, so React and other framework inputs register properly. Typing is checked and retried when needed.
- **A full toolkit.** Click, type, keys, select, hover, drag, scroll, upload, wait, back/forward, screenshots, downloads, plus console and network logs for debugging.

**Control and safety**
- **See everything.** A glow and ghost cursor show what the agent is doing, and stay out of screenshots. The toolbar badge shows each profile's status: active (green), standby (grey) or paused (red).
- **One-click control.** The popup lists the agents in that profile with a Stop button, lets you block Cohand on the current site, and pauses everything with one button.
- **Guardrails on by default.** Banks, payment pages, password managers and Google account security pages are blocked. Password fields are refused. Cookie *values* are never exposed.
- **Private logs.** Every action is logged locally (`cohand log`). Typed text and scripts are stored as length only, and URLs drop their query strings.

**Setup**
- **One-command install.** `cohand install` sets up the background service (launchd, systemd or tmux) and the Chrome connection, and installs the agent skill to the shared `~/.agents/skills` folder plus each agent it finds: Claude Code, Codex, Cursor, Gemini CLI, Antigravity, Copilot, Factory, Kiro, Goose, opencode, pi and Grok.
- **100% local.** No server, no account, no telemetry.

## Install

Requirements: **macOS or Linux**, **Chrome**, and **Node.js 20+**.

```bash
npm install -g cohand
cohand install
```

`cohand install` prints the path of the extension folder. Then, in each Chrome profile you want agents to use:

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick that `extension` folder.
3. Name the profile in the Cohand popup.

Check that everything is green:

```bash
cohand doctor
```

**Just the skill?** If Cohand is already installed and you only want an agent to learn it: `npx skills add cohandhq/cohand`.

**From source:** `git clone https://github.com/cohandhq/cohand.git && cd cohand && npm install && node cli/cohand.mjs install`.

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

## Performance

Measured on a MacBook in a normal, everyday Chrome profile (typical results from a handful of runs, November 2026):

| Action | Typical time |
|---|---|
| Read a page as text with refs (`snapshot`) | **~80 ms** |
| Plain text (`text`) / search the page (`find`) | **~65 ms** |
| Screenshot | **~250 ms** |
| Key press | **~80 ms** |
| Type into a field | **~450 ms** (includes checking the value stuck) |
| Open a page and wait for it to load | **1–2.5 s** (mostly the website itself) |

There's no browser to boot and no login to replay: commands go straight to a Chrome that's already running.

### Smaller pages for your agent

What an agent reads costs tokens. Cohand's snapshots are compact:

| Hacker News front page | Approx. tokens |
|---|---|
| **Cohand `snapshot`** | **~2.5K** |
| Playwright MCP | ~12.3K |
| Chrome DevTools MCP | ~13.3K |

That's **about 5x smaller** on the same page. Every command's output is also capped at ~15K characters (~4K tokens); anything longer is saved to a file the agent can open if it needs to, so one huge page never floods its context.

<sub>Cohand: our measurement, tokens estimated as characters ÷ 4. Others: [published test, 68 runs](https://dev.to/jaehyun_cho_0dff271e0d2e5/browser-mcp-token-cost-68-runs-of-playwright-mcp-vs-chrome-devtools-mcp-and-a-proxy-that-cuts-1ee). Page content changes day to day, so treat these as ballpark figures.</sub>

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

The full, honest list: [docs/ISSUES.md](docs/ISSUES.md).

## Roadmap

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

Licensed under the [Apache License 2.0](LICENSE).
