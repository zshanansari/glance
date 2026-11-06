/**
 * The manifest the app checks for updates against.
 *
 * Tauri builds the update payload and its signature but not this file, so the
 * release step writes it. The app verifies `signature` against the public key
 * compiled into it, which is why the signature travels in the manifest rather
 * than beside the download.
 *
 * The manifest itself is not signed. Whoever can change it can offer a
 * different version or a dead link, but not get a payload installed that the
 * update key did not sign.
 */

/** What Tauri's updater calls each architecture a Mac app can be built for. */
const UPDATER_TARGETS = { arm64: "darwin-aarch64", x86_64: "darwin-x86_64" };

/**
 * The updater targets a built app serves, from the architectures `lipo -archs`
 * lists for its binary: one for a single-architecture build, both for a
 * universal one. Read from the build rather than assumed, so an Intel or
 * universal release is never offered under the wrong name.
 */
export function updaterTargets(archs) {
  const targets = archs
    .trim()
    .split(/\s+/)
    .map((arch) => UPDATER_TARGETS[arch])
    .filter(Boolean);
  if (!targets.length) throw new Error(`no updater target for architectures "${archs.trim()}"`);
  return targets;
}

export function updaterManifest({
  version,
  notes,
  signature,
  url,
  targets = ["darwin-aarch64"],
  date = new Date(),
}) {
  if (!version) throw new Error("a manifest needs the version it offers");
  if (!signature) throw new Error("a manifest without a signature cannot be verified");
  if (!url) throw new Error("a manifest needs the URL of the update payload");
  return {
    // The app compares this to its own version, so it carries no leading v.
    version: version.replace(/^v/, ""),
    notes,
    pub_date: date.toISOString(),
    platforms: Object.fromEntries(targets.map((target) => [target, { signature, url }])),
  };
}

/** Where the release publishes the payload a given tag's manifest points at. */
export function payloadUrl({ repository, tag, file }) {
  return `https://github.com/${repository}/releases/download/${tag}/${file}`;
}
