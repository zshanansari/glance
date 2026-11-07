# Building

Glance is a Tauri 2 app. The web UI is TypeScript; the menu bar extra is Rust.

Shipping a notarized disk image is a separate step; see [Releasing](release.md).

## Toolchain

- macOS 13 or newer
- Node 22 and [pnpm 9.4](https://pnpm.io) (the version pinned in `package.json`)
- A current stable Rust toolchain (`rustup`)
- Xcode Command Line Tools (`xcode-select --install`)

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm app
```

`pnpm app` builds and opens a debug `Glance.app` bundle. It layers
`src-tauri/tauri.dev.conf.json` over the config to skip the update payload,
which would otherwise ask for the signing key on every local build. This includes the
app identity and Calendar usage descriptions needed for macOS permission prompts.
Look for Glance in the menu bar.

macOS ties Calendar and Reminders access to the app's code signature. The
default ad-hoc signature changes with every build, so each rebuild asks again.
Sign local builds with a stable identity instead, such as a self-signed
code-signing certificate in your login keychain:

```bash
APPLE_SIGNING_IDENTITY="Glance Development" pnpm app
```

Launch the bundle (with `open` or from Finder), not the executable inside it:
started from a terminal, macOS checks the terminal's permissions instead.

`pnpm dev` builds the UI once and runs the unbundled executable, with the
web inspector available. Rust changes rebuild on save; a UI change needs
`pnpm dev` run again. Use `pnpm app` when testing Calendar permissions.

Debug builds keep the TypeScript source maps next to the bundles so the
inspector shows the original source. `pnpm dmg` leaves them out of the
shipped app.

For an unnotarized local disk image that is not for shipping:

```bash
pnpm tauri build --bundles dmg
```

## Icons

`pnpm icon` regenerates `icons/icon.png`, `icons/icon.icns`,
`icons/tray-icon.png`, `icons/tray/calendar.png`, and
`icons/tray/filled/day-01.png` through `day-31.png` from
`scripts/generate-icon.swift`. The framed menu bar glyph holds text, so the
renderer draws it at runtime in `src/renderer/tray-frame.ts`.

`pnpm dmg:background` regenerates `icons/dmg/background.tiff`, the
drag-to-Applications art in the disk image. Only run it when that art changes.

## Tests

`pnpm test` runs the TypeScript suite and `cargo test` for the host. Neither
needs a signed bundle.
