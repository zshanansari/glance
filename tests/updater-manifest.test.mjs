import { describe, expect, it } from "vitest";
import { payloadUrl, updaterManifest, updaterTargets } from "../scripts/updater-manifest.mjs";

const base = {
  version: "v0.3.0",
  notes: "Fixes things",
  signature: "dW50cnVzdGVk",
  url: "https://github.com/o/r/releases/download/v0.3.0/Glance.app.tar.gz",
  date: new Date("2026-09-09T12:00:00Z"),
};

describe("updater manifest", () => {
  it("offers the version without the tag's v", () => {
    // The app compares this against its own version, which has no v.
    expect(updaterManifest(base).version).toBe("0.3.0");
    expect(updaterManifest({ ...base, version: "0.3.0" }).version).toBe("0.3.0");
  });

  it("carries the signature and payload for the shipped target", () => {
    const manifest = updaterManifest(base);
    expect(manifest.platforms["darwin-aarch64"]).toEqual({
      signature: base.signature,
      url: base.url,
    });
    expect(manifest.pub_date).toBe("2026-09-09T12:00:00.000Z");
    expect(manifest.notes).toBe("Fixes things");
  });

  it("names the targets the built binary serves", () => {
    expect(updaterTargets("arm64\n")).toEqual(["darwin-aarch64"]);
    expect(updaterTargets("x86_64")).toEqual(["darwin-x86_64"]);
    expect(updaterTargets("x86_64 arm64")).toEqual(["darwin-x86_64", "darwin-aarch64"]);
    expect(() => updaterTargets("")).toThrow(/no updater target/);
    const universal = updaterManifest({ ...base, targets: ["darwin-x86_64", "darwin-aarch64"] });
    expect(Object.keys(universal.platforms)).toEqual(["darwin-x86_64", "darwin-aarch64"]);
  });

  it("refuses a manifest nothing could verify", () => {
    expect(() => updaterManifest({ ...base, signature: "" })).toThrow(/signature/);
    expect(() => updaterManifest({ ...base, version: "" })).toThrow(/version/);
    expect(() => updaterManifest({ ...base, url: "" })).toThrow(/URL/);
  });

  it("points at the asset the tag publishes", () => {
    expect(
      payloadUrl({ repository: "o/r", tag: "v0.3.0", file: "Glance.app.tar.gz" }),
    ).toBe("https://github.com/o/r/releases/download/v0.3.0/Glance.app.tar.gz");
  });
});
