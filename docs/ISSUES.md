# Known issues

Open problems we know about. Over 35 earlier issues are already fixed. New reports go to [GitHub Issues](https://github.com/cohandhq/cohand/issues). Pull requests for anything below are very welcome.

## Page reading

- **Thin snapshots on some app-style pages.** On heavily scripted single-page apps, `snapshot`, `find` and `text` can return only the page chrome (sidebar, header) and miss the main content. Workaround: `cohand activate` the tab first, or use `screenshot`.
- **Background tabs read poorly.** Some pages render their main content only once the tab is visible. Since 0.2.4, `cohand open` brings its tab to the front when you are already looking at the agent's group (it never steals focus from your own tabs); otherwise use `cohand activate`.
- **Hidden file inputs get no ref.** Styled "Upload" buttons that wrap a hidden `<input type=file>` expose no ref for `upload`.
- **Frame preflight on DOM-heavy pages.** The per-frame policy check can fail reads on very large pages, and `--scope` does not help.

## Clicking and input

_Fixed in 0.2.2: clicks no longer wait for slow pages to finish loading (they return once navigation starts, with `navigated`/`loading` flags), late link navigations are detected, and a click or page command is never sent twice._

- **`select` on custom comboboxes** reads options in the same tick as opening them, so async menus report "no visible option".
- **Overlay cursor is offset inside same-origin iframes.**
- **Pop-up menu options can have no ref.** Some sort menus render options as plain list items (for example a hotel site's "Price: low to high", or GitHub search's "Most stars"), so they get no ref and must be clicked by position (`cohand click x,y --from-shot`).
- **Some autocomplete suggestions don't select on click.** On flight-search style comboboxes, clicking a suggestion leaves the dropdown open; pressing `ArrowDown` then `Enter` works.
- **A user-opened New Tab inside the agent's group** can make commands target `chrome://` and fail.
- **Clicking a "N comments" link by ref on a news aggregator** reported `navigated: false` twice and the tab stayed on the listing page; workaround was to open the story's item URL directly with `cohand open`.

## Daemon, CLI and install

_Fixed in 0.2.3: `install`/`doctor --help` show help instead of running, and unknown flags are refused; a corrupt `policy.json` falls back to the built-in defaults instead of blocking everything; a failed log write no longer turns a finished action into an error; `wait --timeout` is honoured._

- Oversized commands time out instead of erroring clearly; one zero-length frame can stop the host.
- Restarting the daemon drops in-flight commands, and the CLI then waits ~155 s.
- Renaming a Chrome profile drops its policy.
- Session identity is the tab-group title, so renaming a group forks the session.
- Tabs used with `console` / `network` stay attached to the debugger.
- `log --today` is a no-op (today is already the default), and earlier days can't be read from the CLI.
- The tmux fallback reports success without checking it started.
- `screenshot --full` can repeat the first screen instead of capturing the whole page.

## Tests

- The extension layer (`background.js`, `executors.js`, `content.js`, `popup.js`) has no direct tests yet. Routing and error-handling contract tests would be a great first contribution.
