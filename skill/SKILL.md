---
name: cohand
description: Use when you need to drive a real Chrome browser the user is logged into (whichever profile the user is using) - read pages, click, type, fill forms, take screenshots - through the local `cohand` CLI. Works in the user's own profiles, in your own tab group.
---

# cohand: drive the user's real Chrome

`cohand` is a local CLI. It controls real Chrome profiles (logins intact). You work in your own
tab group named `🤖 <your session name>`. You never touch the user's other tabs.

## Start

1. `cohand session start <short-name>` - starts a new session pinned to the profile the user is using right now (the "front" profile) and prints `export COHAND_SESSION=<id>`. Run that export in your shell. You stay on that profile even if the user switches windows.
2. For a task continuing after a chat turn, keep `COHAND_SESSION` and the session live. Use `cohand session resume <id>` if the shell lost the variable; it reuses the same session and group. Do not run `session start` again unless this is a genuinely new concurrent task.
3. `cohand adopt <tabId> --any-tab` moves one exact user-designated existing tab into the current session group without reopening or reloading it. Outside-group adoption needs the profile's existing any-tab toggle; adoption of a tab already in the group is idempotent.
4. You do not need `--profile`. Only add `--profile <name>` to force a specific profile (`cohand profiles` lists them).
5. `cohand open https://example.com` - opens a tab inside your group.

## Work loop

- `cohand snapshot` - page as text with element refs like `[e12]`. Use this by default.
- Act by ref: `cohand click e12`, `cohand type e5 "hello"`, `cohand key Enter`, `cohand select e7 "Large"`,
  `cohand scroll down`, `cohand wait --text "Saved"`.
- Prefer `snapshot` over `screenshot`: it is cheaper and exact. Use `cohand screenshot` only for visual checks;
  it prints a file path, then read that file.
- After any navigation or big page change, run `cohand snapshot` again. Old refs go stale.
- `cohand find "save draft"` filters the snapshot by words. `cohand text --selector main` reads plain text.
- `cohand tabs` lists tabs in your group. The user can drag a tab into your group to hand it to you.
- Typing into React-style inputs works: cohand checks the value stuck and retries with real keyboard input.

## Safety rules (enforced by the daemon, not optional)

- Approval prompts are off by default, so form submits, Enter-to-send, upload, and eval proceed.
- Blocked sites (banks, payments, password managers, Google account security) are refused.
- Never handle passwords or payments. Password fields are blocked; ask the user to do those steps.
- Cookie values are never returned (`cohand cookies <url>` gives names only).
- If you get "cohand is switched off", the user disabled you. Stop.
- Every command is logged on the user's machine (`cohand log`). Typed text and eval scripts are logged as length only; logged URLs drop query strings.

## Field tips (known rough edges, until fixed)

- Each shell command is a fresh shell: re-export `COHAND_SESSION=<id>` in every command, or save the id to a file and read it back.
- Big web apps: `snapshot` walks through `display:contents` wrappers. If the main panel is still missing, try `cohand text` or `cohand snapshot --scope '[role="main"]'`. A cross-origin frame is labeled and cannot be read.
- Clicking by position: `cohand click x,y` takes CSS pixels. `cohand screenshot` prints `Screenshot scale: Nx`; image pixels divided by N are CSS pixels. Or pass image pixels directly: `cohand click x,y --from-shot`. Do not assume the scale is 2.
- `cohand type e5 "hello"` types into a ref. `cohand type 100,200 "hello"` and `cohand type focused "hello"` type at a point or into the focused element. `cohand type x,y "hello" --from-shot` uses image pixels.
- `cohand key .` and `cohand key Space` insert that character. `cohand key Meta+a` selects all.
- `cohand scroll` targets the nearest scrollable panel under the viewport centre. If it moves the wrong area, click inside the panel first and try again.
- Current tab URL: `cohand url`. `cohand activate <tabId>` makes that tab the one later commands read.
- Commands can take a few seconds on heavy pages; use `cohand wait --text "<something on the page>"` after `open`.

## Report problems (please do this)

When cohand fails, behaves oddly, or forces a workaround, add one bullet to the matching section of
`docs/ISSUES.md` in the cohand checkout: what you ran, what happened, what you expected, and the
workaround. Describe sites generically (e.g. "a React dashboard"); never include private URLs,
names, or account details.

Don't fix cohand code yourself and don't commit; just add the bullet and tell the user you logged it.

## Finish

If the task is actually complete, run `cohand session end`; it ungroups tabs but never closes them. If the task is paused or continuing in another chat turn, do not end the session—keep the session ID and resume it later.

## Errors

- `cohandd not running` - run `cohand doctor` and report what it says.
- `profile <name> disconnected — reopen it or start a new session` - your profile's Chrome closed. Ask the user to reopen it, or run `cohand session start` again.
- `no tabs in session group` - run `cohand open <url>` or ask the user to drag a tab in.
