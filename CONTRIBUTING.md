# Contributing

Issues and pull requests are welcome. Please follow the [code of conduct](CODE_OF_CONDUCT.md).
For security issues, use [private reporting](SECURITY.md).

## Your first pull request

1. Fork the repository and clone your fork. Create a branch for one focused change.
2. Install dependencies with `pnpm install --frozen-lockfile` using the pnpm version
   in `package.json`. Follow [Building](docs/building.md) for native prerequisites.
3. Make the change and update relevant docs. Run `pnpm typecheck`, `pnpm test`,
   and `pnpm build` for code changes.
4. Commit and push your branch, then open a pull request against `main`.
5. Respond to review feedback. The maintainer handles merging and
   [releases](docs/release.md).

## What is in scope

Glance is a month view in the menu bar that reads Calendar and Reminders on
this Mac through EventKit: the day's events, a countdown to the next one, a
reminder card before a call, search, and quick add for new events in plain
words. It does not sync accounts or send calendar data off the Mac; the only
connections it makes are the update check and the Google Calendar handoff the
user chooses. Changes that keep to that, and to the plain macOS look, fit.

For anything large, open an issue before writing it.
