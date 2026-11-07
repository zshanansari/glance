#!/usr/bin/env swift
// Renders the SF Symbols the pages use into icons/symbols, black on clear at
// 3x, so the webviews can draw Apple's own glyphs as CSS masks in any color.
// Re-run (pnpm symbols) after adding a name below.
import AppKit
import Foundation

let script = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL
let root = script.deletingLastPathComponent().deletingLastPathComponent()
let out = root.appendingPathComponent("icons/symbols")
try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)

/// Symbol name, and the weight it is drawn at.
let symbols: [(String, NSFont.Weight)] = [
    // Settings sidebar tiles, as System Settings marks its panes.
    ("gearshape.fill", .regular),
    ("circle.lefthalf.filled", .regular),
    ("calendar", .medium),
    ("calendar.badge.clock", .medium),
    ("info.circle.fill", .regular),
    // Controls.
    ("speaker.wave.2.fill", .regular),
    ("checkmark", .semibold),
    ("chevron.left", .semibold),
    ("chevron.right", .semibold),
    // Event details.
    ("mappin.and.ellipse", .regular),
    ("eye.slash", .regular),
    ("video.fill", .regular),
    ("arrow.up.right", .semibold),
    ("clock", .regular),
    ("magnifyingglass", .regular),
    ("map", .regular),
]

/// Every glyph shares one square canvas, so they line up at any size.
let canvas = 96.0

for (name, weight) in symbols {
    let config = NSImage.SymbolConfiguration(pointSize: 64, weight: weight)
    guard let symbol = NSImage(systemSymbolName: name, accessibilityDescription: nil)?
        .withSymbolConfiguration(config)
    else {
        fputs("No symbol named \(name)\n", stderr)
        exit(1)
    }
    let size = symbol.size
    let scale = min(canvas / size.width, canvas / size.height) * 0.9
    let drawn = NSSize(width: size.width * scale, height: size.height * scale)
    let image = NSImage(size: NSSize(width: canvas, height: canvas), flipped: false) { _ in
        let rect = NSRect(
            x: (canvas - drawn.width) / 2,
            y: (canvas - drawn.height) / 2,
            width: drawn.width,
            height: drawn.height
        )
        symbol.draw(in: rect)
        NSColor.black.set()
        rect.fill(using: .sourceAtop)
        return true
    }
    guard let tiff = image.tiffRepresentation,
          let bitmap = NSBitmapImageRep(data: tiff),
          let png = bitmap.representation(using: .png, properties: [:])
    else {
        fputs("Could not render \(name)\n", stderr)
        exit(1)
    }
    try png.write(to: out.appendingPathComponent("\(name).png"))
}
print("Wrote \(symbols.count) symbols in \(out.path)")
