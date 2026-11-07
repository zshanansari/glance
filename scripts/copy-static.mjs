import { cp, mkdir, rm } from "node:fs/promises";
import { build } from "esbuild";

// A release carries no source maps: Tauri embeds everything under
// dist/renderer, and the maps hold the whole TypeScript source. Debug builds
// keep them for the web inspector.
const sourcemap = !process.env.GLANCE_RELEASE;

const bundle = (entry, outfile) =>
  build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "browser",
    format: "iife",
    sourcemap,
  });

await mkdir("dist/renderer", { recursive: true });
// A map left by an earlier debug build would be embedded all the same.
if (!sourcemap) {
  for (const page of ["calendar", "reminder", "settings"]) {
    await rm(`dist/renderer/${page}.js.map`, { force: true });
  }
}
await rm("dist/renderer/tray", { recursive: true, force: true });
await rm("dist/renderer/brands", { recursive: true, force: true });
await rm("dist/renderer/symbols", { recursive: true, force: true });
// The upcoming-events popover became the meeting reminder.
for (const stale of ["events.html", "events.css", "events.js", "events.js.map"]) {
  await rm(`dist/renderer/${stale}`, { force: true });
}
await Promise.all([
  cp("src/renderer/system.css", "dist/renderer/system.css"),
  cp("src/renderer/calendar.html", "dist/renderer/calendar.html"),
  cp("src/renderer/calendar.css", "dist/renderer/calendar.css"),
  cp("src/renderer/reminder.html", "dist/renderer/reminder.html"),
  cp("src/renderer/reminder.css", "dist/renderer/reminder.css"),
  cp("src/renderer/settings.html", "dist/renderer/settings.html"),
  cp("src/renderer/settings.css", "dist/renderer/settings.css"),
  cp("icons/tray", "dist/renderer/tray", { recursive: true }),
  cp("icons/brands", "dist/renderer/brands", { recursive: true }),
  cp("icons/symbols", "dist/renderer/symbols", { recursive: true }),
  cp("icons/icon.png", "dist/renderer/icon.png"),
  bundle("src/renderer/calendar.ts", "dist/renderer/calendar.js"),
  bundle("src/renderer/reminder.ts", "dist/renderer/reminder.js"),
  bundle("src/renderer/settings.ts", "dist/renderer/settings.js"),
]);
