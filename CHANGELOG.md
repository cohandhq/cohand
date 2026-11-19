# Changelog

## 0.2.3 (2026-11-19)

- `cohand install --help` and `cohand doctor --help` now show help instead of running; unknown options are refused.
- A corrupt `policy.json` no longer blocks every command: Cohand falls back to the built-in defaults (bank, payment and password-manager blocks stay on) and leaves the file for you to fix.
- A failed log write no longer turns a finished action into an error (it previously could hang).
- `wait --timeout` is honoured.
- Removed unused protocol code.

## 0.2.2 (2026-11-19)

- Clicks return as soon as navigation starts instead of waiting up to 15 s for slow pages; results include `navigated` and `loading`.
- Late link navigations (after 300 ms) are detected instead of reported as "nothing happened".
- A click is never fired twice, and page commands are only retried when the page helper is missing.

## 0.2.1 (2026-11-19)

- New logo and extension icons; README rewrite with highlights, features and performance numbers.

## 0.2.0 (2026-11-19)

- First public release on npm.
- Agent skill installs to the shared `~/.agents/skills` folder plus Claude Code, Codex, Cursor, Gemini CLI, Antigravity, Copilot, Factory, Kiro, Goose, opencode, pi and Grok.
- Cleaner extension popup.
