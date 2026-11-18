# Installing cohand on a remote box

Two parts: the CLI/daemon (terminal) and the Chrome extension. Both come from the same repo.

## 1. Get the repo

```bash
export COHAND_REPO=~/cohand        # any folder you like
git clone https://github.com/cohandhq/cohand.git "$COHAND_REPO"
cd "$COHAND_REPO"
npm install          # dev deps for tests only; the CLI itself has no deps
```

## 2. Install the CLI + daemon

```bash
node "$COHAND_REPO/cli/cohand.mjs" install
```

This starts the daemon at login (launchd on macOS, systemd --user on Linux, or a `tmux`
session named `cohand` if a user systemd instance is not available), registers the Chrome
native-messaging host (on Linux: `~/.config/google-chrome/NativeMessagingHosts` and
`<user-data-dir>/NativeMessagingHosts` for every Chrome profile directory), puts `cohand`
in `~/.local/bin`, and copies the skill to any agents found (Claude, codex, pi, opencode, grok).

## 3. Load the Chrome extension

In each Chrome profile you want to work in:

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. **Load unpacked** → select `"$COHAND_REPO"/extension`
4. Open the cohand toolbar popup and name the profile

## 4. Verify

```bash
cohand doctor        # everything should be ✔
export COHAND_SESSION=$(cohand session start test -q)
cohand open https://example.com
cohand snapshot
cohand session end
```

## Updating later

```bash
cd "$COHAND_REPO" && git pull
cohand install       # refresh CLI + skill copies
```

Then reload the extension in `chrome://extensions` (you have to click reload; the badge does not prompt for it). Daemon changes apply on the daemon's next restart — the supervisor starts the new code when the daemon exits. Existing sessions are preserved in `~/.cohand/sessions.json`.
