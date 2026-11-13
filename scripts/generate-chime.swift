#!/usr/bin/env swift
// Synthesizes the hourly chime into src-tauri/resources/chime.wav: two short
// beeps, like a digital watch marking the hour. Everything is computed here, so
// the sound is Glance's own. Re-run with `pnpm chime` after changing a value.
//
//   swift scripts/generate-chime.swift [output.wav]
import Foundation

let script = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL
let root = script.deletingLastPathComponent().deletingLastPathComponent()
let out = CommandLine.arguments.count > 1
    ? URL(fileURLWithPath: CommandLine.arguments[1])
    : root.appendingPathComponent("src-tauri/resources/chime.wav")

let sampleRate = 44_100.0

/// One tone: partials as (frequency ratio, level, decay time in seconds).
struct Tone {
    var start: Double
    var length: Double
    var pitch: Double
    var partials: [(ratio: Double, level: Double, decay: Double)]
    var attack: Double
    var release: Double
}

/// Peak level of the finished sound. The app plays it at a capped volume; this
/// keeps it about as loud as the chime it replaced.
let peak = 0.36

// Two short buzzer beeps, a quarter second apart, the way a digital watch
// marks the hour. A piezo buzzer holds its level and sounds mostly at its
// second harmonic, so the partials barely decay and the 2x one leads.
let partials: [(ratio: Double, level: Double, decay: Double)] = [
    (1.0, 0.15, 10), (2.0, 1.0, 10), (3.0, 0.27, 10),
]
let tones = [0.02, 0.27].map {
    Tone(start: $0, length: 0.15, pitch: 4100.0, partials: partials, attack: 0.003, release: 0.008)
}

let duration = tones.map { $0.start + $0.length }.max()! + 0.05
let count = Int(duration * sampleRate)
var samples = [Double](repeating: 0, count: count)

for tone in tones {
    let first = Int(tone.start * sampleRate)
    let frames = Int(tone.length * sampleRate)
    for frame in 0..<frames where first + frame < count {
        let t = Double(frame) / sampleRate
        // Raised-cosine edges, so neither end clicks.
        let fadeIn = t < tone.attack ? 0.5 - 0.5 * cos(.pi * t / tone.attack) : 1
        let left = tone.length - t
        let fadeOut = left < tone.release ? 0.5 - 0.5 * cos(.pi * left / tone.release) : 1
        var value = 0.0
        for partial in tone.partials {
            value += partial.level * exp(-t / partial.decay)
                * sin(2 * .pi * tone.pitch * partial.ratio * t)
        }
        samples[first + frame] += value * fadeIn * fadeOut
    }
}

let loudest = samples.map(abs).max() ?? 1
let pcm = samples.map { Int16(max(-1, min(1, $0 / loudest * peak)) * Double(Int16.max)) }

/// A 16-bit mono PCM WAV file, written by hand so the output is the same
/// bytes on every Mac.
var data = Data()
func append<T: FixedWidthInteger>(_ value: T) { withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) } }
let bytes = UInt32(pcm.count * 2)
data.append(contentsOf: Array("RIFF".utf8)); append(UInt32(36) + bytes)
data.append(contentsOf: Array("WAVE".utf8))
data.append(contentsOf: Array("fmt ".utf8)); append(UInt32(16)); append(UInt16(1)); append(UInt16(1))
append(UInt32(sampleRate)); append(UInt32(sampleRate) * 2); append(UInt16(2)); append(UInt16(16))
data.append(contentsOf: Array("data".utf8)); append(bytes)
for sample in pcm { append(sample) }
try data.write(to: out)
print("Wrote \(out.path) (\(String(format: "%.2f", duration)) s)")
