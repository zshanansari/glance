// Assembles the landing page in dist/site: the page from site/, with the
// README's screenshots and the app icon beside it, so neither is kept twice.
// The Pages workflow publishes this folder; `pnpm site` builds it to preview.
import { cp, mkdir, rm } from "node:fs/promises";

const out = "dist/site";

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await Promise.all([
  cp("site", out, { recursive: true }),
  cp("docs/screenshots", `${out}/screenshots`, { recursive: true }),
  cp("icons/icon.png", `${out}/icon.png`),
]);
console.log(`Landing page assembled in ${out}`);
