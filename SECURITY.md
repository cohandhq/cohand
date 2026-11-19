# Security policy

Cohand acts inside your real, logged-in Chrome, so we take security reports seriously.

## Reporting a vulnerability

Please **don't open a public issue**. Report privately through GitHub:
**[Report a vulnerability](https://github.com/cohandhq/cohand/security/advisories/new)**.

Include what you found, how to reproduce it, and what an attacker could do with it. We'll acknowledge your report within a few days and keep you updated until it's fixed.

## What's in scope

Anything that lets an agent, a web page or another local process get around Cohand's guardrails, for example:

- reaching tabs outside the agent's own tab group without the any-tab setting
- reading cookie values or password fields
- acting on a blocked site (banks, payments, password managers, Google account security)
- running commands while Cohand is paused or switched off
- talking to the daemon from another user account, or from a web page
- typed text, scripts or URL query strings leaking into the log

## Supported versions

Security fixes go into the latest release on npm. Please update before reporting.
