# Contributing to Cohand

Thanks for helping! Bug reports, fixes, tests and new commands are all welcome.

## Getting started

```bash
git clone https://github.com/cohandhq/cohand.git
cd cohand
npm install
npm test          # Node's built-in test runner, no browser needed
```

To try your changes in Chrome, run `node cli/cohand.mjs install`, then load the `extension` folder unpacked in `chrome://extensions`.

## Where things live

| Folder | What it does |
|---|---|
| `cli/` | the `cohand` command |
| `daemon/` | routes commands to the right profile, enforces policy, writes the log |
| `host/` | native-messaging bridge between Chrome and the daemon |
| `extension/` | runs commands in the page: snapshot, click, type, overlay, popup |
| `skill/` | the instructions installed into each agent |
| `tests/` | `node:test` suites; `tests/helpers.mjs` has a fake daemon client and host |

## Good first contributions

Pick anything from [docs/ISSUES.md](docs/ISSUES.md). Tests for the extension layer (`executors.js`, `background.js`, `popup.js`) are especially welcome.

## Pull requests

- Add a test that fails before your change and passes after it.
- Keep changes small and match the surrounding style: small functions, short comments, no new dependencies unless there's a strong reason.
- `npm test` must pass.
- After changing the extension, reload it in `chrome://extensions`. After changing `skill/SKILL.md`, re-run `cohand install`.
- In the PR, say what you changed and how you checked it.

Never include private URLs, cookies or account details in issues, tests or logs. Describe sites generically.

By contributing you agree your work is licensed under the [Apache License 2.0](LICENSE).

## Releasing (maintainers)

Bump `version` in `package.json` and `extension/manifest.json`, add a `CHANGELOG.md` entry, push, then publish a GitHub Release tagged `vX.Y.Z`. The release workflow runs the tests and publishes to npm with provenance.
