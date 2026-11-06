/**
 * Builds the release disk image, notarized end to end.
 *
 * Tauri notarizes and staples the `.app`, then wraps it in a disk image it
 * never submits, so Gatekeeper rejects the very file a user downloads. This
 * submits the image too and refuses to finish until `spctl` accepts it.
 *
 * Credentials come from `.env.notarization`, which is gitignored:
 * APPLE_ID, APPLE_TEAM_ID, APPLE_PASSWORD (an app-specific password) and
 * APPLE_SIGNING_IDENTITY. CI can pass them as environment variables instead.
 * NOTARY_PROFILE names a `xcrun notarytool store-credentials` profile, so the
 * disk image is submitted with the password kept in the Keychain.
 *
 * Secrets go only to the step that needs them: the build gets the Apple and
 * update-signing secrets, notarytool the Apple ones, and nothing else either.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { payloadUrl, updaterManifest, updaterTargets } from "./updater-manifest.mjs";

const ENV_FILE = ".env.notarization";
const DMG_DIR = "src-tauri/target/release/bundle/dmg";
const MACOS_DIR = "src-tauri/target/release/bundle/macos";
const REQUIRED = ["APPLE_ID", "APPLE_TEAM_ID", "APPLE_PASSWORD"];
const APPLE_SECRETS = ["APPLE_ID", "APPLE_TEAM_ID", "APPLE_PASSWORD", "NOTARY_PROFILE"];
const SIGNING_SECRETS = ["TAURI_SIGNING_PRIVATE_KEY", "TAURI_SIGNING_PRIVATE_KEY_PASSWORD"];
/// Where the update signing key lives, in order of preference. It sits with
/// the other macOS signing material rather than in the repository: it cannot
/// be revoked or rotated, since every installed copy trusts exactly the one
/// key compiled into it.
const SIGNING_KEYS = [join(homedir(), ".glance", "updater.key")];
const REPOSITORY = "zshanansari/glance";

function loadCredentials() {
  if (!existsSync(ENV_FILE)) return;
  for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, raw] = match;
    // Later definitions lose to whatever the environment already carries.
    if (process.env[key]) continue;
    process.env[key] = raw.trim().replace(/^["']|["']$/g, "");
  }
}

/** The environment without any secret, plus the ones a step is handed. */
function envWith(secrets = []) {
  const env = { ...process.env };
  for (const key of [...APPLE_SECRETS, ...SIGNING_SECRETS]) {
    if (!secrets.includes(key)) delete env[key];
  }
  return env;
}

function run(command, args, label, secrets = []) {
  const result = spawnSync(command, args, { stdio: "inherit", env: envWith(secrets) });
  if (result.status !== 0) {
    console.error(`\n${label} failed.`);
    process.exit(result.status ?? 1);
  }
}

/// The private key signs the update payload; without it the app would refuse
/// every update it is offered.
function loadSigningKey() {
  if (process.env.TAURI_SIGNING_PRIVATE_KEY) return;
  const key = SIGNING_KEYS.find((path) => existsSync(path));
  if (!key) {
    console.error(
      `No update signing key found. Looked in:\n` +
        SIGNING_KEYS.map((path) => `  ${path}`).join("\n") +
        `\n\nSet TAURI_SIGNING_PRIVATE_KEY to its path, or generate one with:\n` +
        `  pnpm tauri signer generate -w ${SIGNING_KEYS[0]}\n\n` +
        `A new key orphans every copy already installed: they trust only the\n` +
        `key compiled into them, and would need a manual reinstall.`,
    );
    process.exit(1);
  }
  process.env.TAURI_SIGNING_PRIVATE_KEY = key;
  process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ??= "";
}

function findOne(directory, suffix, label) {
  const files = existsSync(directory)
    ? readdirSync(directory).filter((name) => name.endsWith(suffix))
    : [];
  if (files.length !== 1) {
    console.error(
      `Expected exactly one ${label} in ${directory}, found ${files.length}.`,
    );
    process.exit(1);
  }
  return join(directory, files[0]);
}

/// What Settings shows under "What's new": the file given with --notes, as
/// written, or else a pointer to the release page.
function releaseNotes(tag) {
  const flag = process.argv.indexOf("--notes");
  const file = flag === -1 ? null : process.argv[flag + 1];
  if (file) {
    if (!existsSync(file)) {
      console.error(`No release notes at ${file}.`);
      process.exit(1);
    }
    return readFileSync(file, "utf8").trim();
  }
  return `See https://github.com/${REPOSITORY}/releases/tag/${tag}`;
}

/// Writes the manifest the app fetches, pointing at the payload this tag will
/// publish. The version comes from the build, so the two cannot drift.
function writeManifest(version, notes) {
  const payload = findOne(MACOS_DIR, ".app.tar.gz", "update payload");
  const signature = readFileSync(`${payload}.sig`, "utf8").trim();
  const tag = `v${version}`;
  const manifest = updaterManifest({
    version,
    notes,
    signature,
    targets: updaterTargets(
      spawnSync("lipo", ["-archs", join(MACOS_DIR, "Glance.app", "Contents", "MacOS", "glance")], {
        encoding: "utf8",
      }).stdout ?? "",
    ),
    url: payloadUrl({ repository: REPOSITORY, tag, file: payload.split("/").pop() }),
  });
  const path = join(DMG_DIR, "latest.json");
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest: path, payload, signature: `${payload}.sig` };
}

/**
 * The certificate the app is signed with. It has to be the same one every
 * release: macOS records a Calendar permission against the signature, and an
 * ad-hoc signature changes with every build, so each update would come back
 * asking for access again. "-" (ad-hoc) is refused for that reason.
 */
function signingIdentity() {
  const identity = (process.env.APPLE_SIGNING_IDENTITY ?? "").trim();
  if (!identity || identity === "-") {
    console.error(
      "Set APPLE_SIGNING_IDENTITY to the certificate releases are signed with,\n" +
        'for example APPLE_SIGNING_IDENTITY="Glance Development".\n\n' +
        "An ad-hoc signature changes with every build, so installed copies would\n" +
        "lose Calendar access on each update.",
    );
    process.exit(1);
  }
  const found = spawnSync("security", ["find-identity", "-p", "codesigning"], {
    encoding: "utf8",
  });
  if (!found.stdout?.includes(`"${identity}"`)) {
    console.error(`No code-signing certificate named "${identity}" in the keychain.`);
    process.exit(1);
  }
  return identity;
}

/**
 * Checks the built app is tied to the certificate rather than to this one
 * build, which is what keeps Calendar access across updates.
 */
function assertStableSignature(app) {
  const result = spawnSync("codesign", ["-d", "-r-", app], { encoding: "utf8" });
  const requirement = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (!/designated => .*certificate/.test(requirement)) {
    console.error(
      `${app} is not signed with a certificate:\n${requirement.trim()}\n` +
        "Installed copies would lose Calendar access after this update.",
    );
    process.exit(1);
  }
}

/** The disk image this version built, never an older one left beside it. */
function dmgFor(version) {
  const files = existsSync(DMG_DIR)
    ? readdirSync(DMG_DIR).filter(
        (name) => name.endsWith(".dmg") && name.startsWith(`Glance_${version}_`),
      )
    : [];
  if (files.length !== 1) {
    console.error(`Expected one Glance_${version}_*.dmg in ${DMG_DIR}, found ${files.length}.`);
    process.exit(1);
  }
  return join(DMG_DIR, files[0]);
}

/**
 * The version lives in three files. The app reports Cargo's through Tauri's
 * config, the manifest takes package.json's, and a mismatch would ship an
 * update that offers itself again forever.
 */
function releaseVersion() {
  const npm = JSON.parse(readFileSync("package.json", "utf8")).version;
  const tauri = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8")).version;
  const cargo = /^version\s*=\s*"([^"]+)"/m.exec(readFileSync("src-tauri/Cargo.toml", "utf8"))?.[1];
  if (npm !== tauri || npm !== cargo) {
    console.error(
      `Versions disagree: package.json ${npm}, tauri.conf.json ${tauri}, Cargo.toml ${cargo}.\n` +
        `Set all three to the release version, then run again.`,
    );
    process.exit(1);
  }
  return npm;
}

const version = releaseVersion();
// Read before the long build, so a wrong --notes path fails at once.
const notes = releaseNotes(`v${version}`);
loadCredentials();
loadSigningKey();
const identity = signingIdentity();
console.log(`Signing with "${identity}".`);

/// --unnotarized ships without Apple's notarization, for a project with no
/// Developer ID yet: Gatekeeper then asks on first launch (right-click, Open).
/// The update payload is still signed with the updater key either way.
const unnotarized = process.argv.includes("--unnotarized");

const missing = unnotarized ? [] : REQUIRED.filter((key) => !process.env[key]);
if (missing.length) {
  console.error(
    `Cannot build a release image without ${missing.join(", ")}.\n` +
      `Put them in ${ENV_FILE} (gitignored) or export them, then run again.\n` +
      `For an unnotarized local build: pnpm tauri build --bundles dmg`,
  );
  process.exit(1);
}

// The updater payload is built from the app bundle, so both targets run.
run("pnpm", ["tauri", "build", "--bundles", "app,dmg"], "Bundling", [
  ...REQUIRED,
  ...SIGNING_SECRETS,
]);

assertStableSignature(join(MACOS_DIR, "Glance.app"));
const dmg = dmgFor(version);
if (unnotarized) {
  console.warn(`\nNot notarizing ${dmg}: first launch will need right-click, Open.`);
} else {
  console.log(`\nNotarizing ${dmg}`);
  const profile = process.env.NOTARY_PROFILE;
  if (!profile) {
    console.warn(
      "No NOTARY_PROFILE: the password goes to notarytool as an argument, which\n" +
        "other processes on this Mac can read while it runs. Store it once with\n" +
        "  xcrun notarytool store-credentials glance-notary\n" +
        "and set NOTARY_PROFILE=glance-notary in .env.notarization.",
    );
  }
  const credentials = profile
    ? ["--keychain-profile", profile]
    : [
        "--apple-id",
        process.env.APPLE_ID,
        "--team-id",
        process.env.APPLE_TEAM_ID,
        "--password",
        process.env.APPLE_PASSWORD,
      ];
  run(
    "xcrun",
    ["notarytool", "submit", dmg, ...credentials, "--wait"],
    "Notarizing the disk image",
  );
  run("xcrun", ["stapler", "staple", dmg], "Stapling the disk image");
  run("spctl", ["--assess", "--type", "install", "-vv", dmg], "Gatekeeper assessment");
}

const update = writeManifest(version, notes);

console.log(`\nReady to publish v${version}. Upload all three:`);
for (const file of [dmg, update.payload, update.manifest]) {
  console.log(`  ${file}`);
}
console.log(
  `\n  gh release create v${version} --target main \\\n` +
    `    ${dmg} \\\n    ${update.payload} \\\n    ${update.manifest}`,
);
console.log(
  "\nlatest.json is what installed copies read, so a release without it\n" +
    "offers nothing and one without the payload offers a broken download.",
);
