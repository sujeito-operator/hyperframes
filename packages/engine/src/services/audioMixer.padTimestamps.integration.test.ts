import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getFfmpegBinary, getFfprobeBinary } from "../utils/ffmpegBinaries.js";
import { buildPadToDurationFilter } from "./audioPadFilter.js";
import { processCompositionAudio } from "./audioMixer.js";
import type { AudioElement } from "./audioMixer.types.js";

/**
 * Real-FFmpeg regression test for the pad/trim branch template.
 *
 * `apad,atrim=0:<total>` — an indefinite pad bounded by a downstream trim —
 * misbehaves on the FFmpeg 7.x line: audio leaks to `t=0` from three mixed
 * branches onward, and from four branches onward the branch with the largest
 * `adelay` disappears from the mix. Nothing errors; the render succeeds with
 * wrong audio, which is why only an output measurement catches it.
 *
 * Three or fewer clips is not enough — the dropped-branch half of the bug does
 * not appear until four. This mixes five.
 *
 * ## This file is a repro, not a CI guard, and that is deliberate
 *
 * No lane runs it. The engine's `Test` job does not install FFmpeg, and the
 * skip shows up in its own log next to the sibling gated suite:
 *
 *     ↓ src/services/audioMixer.level.test.ts            (2 tests | 2 skipped)
 *     ↓ src/services/audioMixer.padTimestamps.integ...   (1 test  | 1 skipped)
 *
 * Installing FFmpeg from apt would not help either: Ubuntu 24.04 ships the 6.x
 * line, and 6.x is not affected — with the fix reverted this test still passes
 * there. Catching this regression in CI needs a **pinned 7.x** binary in one
 * lane; 7.1.5 is affected as well as 7.0.2, so the tail of the line will do.
 * Until some lane pins one, treat this as the executable record of the repro:
 * run it by hand against a 7.x build, or set `HYPERFRAMES_FFMPEG_PATH` and
 * `HYPERFRAMES_FFPROBE_PATH` at one.
 *
 * The gate below resolves through `getFfmpegBinary()` for that reason. Probing
 * a bare `ffmpeg` on `PATH` while the code under test honours the override
 * means the gate and the subject can measure different binaries — which is
 * exactly the 7-versus-6 setup this file exists for.
 */

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const hasFfmpeg = (() => {
  try {
    execFileSync(getFfmpegBinary(), ["-version"], { stdio: "ignore" });
    execFileSync(getFfprobeBinary(), ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const TOTAL_SECONDS = 43.3;

/** start (s), source duration (s), tone frequency (Hz) */
const CLIPS = [
  { start: 0.3, duration: 7.01, frequency: 400 },
  { start: 19.6, duration: 0.4, frequency: 1000 },
  { start: 20.6, duration: 0.4, frequency: 1200 },
  { start: 30.0, duration: 0.4, frequency: 1500 },
  { start: 40.0, duration: 0.4, frequency: 1800 },
] as const;

/**
 * Mean RMS in dB over a 250ms window starting at `atSeconds`. Digital silence
 * reports `-inf`, which is the signal for "this branch is not in the mix".
 */
function rmsDb(path: string, atSeconds: number): number {
  const probe = spawnSync(
    getFfmpegBinary(),
    [
      "-hide_banner",
      "-v",
      "info",
      "-ss",
      atSeconds.toFixed(3),
      "-t",
      "0.25",
      "-i",
      path,
      "-af",
      "astats=metadata=1",
      "-f",
      "null",
      "-",
    ],
    { encoding: "utf8" },
  );
  const stderr = probe.stderr ?? "";
  const overall = stderr.slice(stderr.lastIndexOf("Overall"));
  const match = /RMS level dB:\s*(\S+)/.exec(overall);
  if (!match) throw new Error(`astats reported no RMS level for ${path} at ${atSeconds}s`);
  const raw = match[1]!;
  return raw.endsWith("inf")
    ? raw.startsWith("-")
      ? -Infinity
      : Infinity
    : Number.parseFloat(raw);
}

describe.skipIf(!hasFfmpeg)("mixed audio branch padding", () => {
  it("keeps t=0 silent and lands all five staggered clips at their offsets", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "hf-padts-base-"));
    const workDir = mkdtempSync(join(tmpdir(), "hf-padts-work-"));
    dirs.push(baseDir, workDir);

    const elements: AudioElement[] = CLIPS.map((clip, i) => {
      const src = `clip-${i}.wav`;
      execFileSync(getFfmpegBinary(), [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        `sine=frequency=${clip.frequency}:duration=${clip.duration}`,
        "-ar",
        "44100",
        "-ac",
        "2",
        "-y",
        join(baseDir, src),
      ]);
      return {
        id: `clip-${i}`,
        src,
        start: clip.start,
        end: clip.start + clip.duration,
        mediaStart: 0,
        layer: 0,
        volume: 1,
        type: "audio",
      };
    });

    const outputPath = join(baseDir, "out.m4a");
    const result = await processCompositionAudio(
      elements,
      baseDir,
      workDir,
      outputPath,
      TOTAL_SECONDS,
    );

    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.tracksProcessed).toBe(CLIPS.length);

    // The earliest clip starts at 0.3s, so the head of the mix is silence.
    // The bug puts every clip's audio here at once, ~-29 dB.
    expect(rmsDb(outputPath, 0)).toBeLessThan(-60);

    // Every clip is audible at its own offset. `-Infinity` here means the
    // branch is missing from the mix entirely, which is the second half of
    // the bug and only shows from four branches onward.
    for (const clip of CLIPS) {
      expect(rmsDb(outputPath, clip.start + 0.02)).toBeGreaterThan(-45);
    }
  }, 120_000);
});

/**
 * The other half of the argument for this chain: it still *bounds* a branch
 * that overruns the composition, and `apad=whole_dur=<total>` does not.
 *
 * This runs the graph directly rather than through `processCompositionAudio`,
 * because the mixer also passes `-t totalDuration` on the output. Asserting the
 * mixer's output duration would therefore pass with `whole_dur` substituted in,
 * with `apad` alone, and with no pad filter at all — the container would be
 * doing the work and the test would prove nothing about the filter chain. The
 * subject here is the chain, so the chain is what gets the input.
 */
describe.skipIf(!hasFfmpeg)("pad chain tail bound", () => {
  /** Renders one 5s source delayed 42s against a 43.3s target, no `-t`. */
  function overrunSeconds(padChain: string): number {
    const dir = mkdtempSync(join(tmpdir(), "hf-padts-tail-"));
    dirs.push(dir);
    const src = join(dir, "src.wav");
    const out = join(dir, "out.wav");

    execFileSync(getFfmpegBinary(), [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=800:duration=5",
      "-ar",
      "44100",
      "-ac",
      "2",
      "-y",
      src,
    ]);
    execFileSync(getFfmpegBinary(), [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      src,
      "-filter_complex",
      `[0:a]atrim=0:5,volume=1,adelay=42000|42000,${padChain}[a0];` +
        `[a0]amix=inputs=1:duration=longest:dropout_transition=0[mixed];[mixed]volume=1[out]`,
      "-map",
      "[out]",
      "-acodec",
      "pcm_s16le",
      out,
    ]);

    const probe = spawnSync(
      getFfprobeBinary(),
      ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", "--", out],
      { encoding: "utf8" },
    );
    const seconds = Number.parseFloat((probe.stdout ?? "").trim());
    if (!Number.isFinite(seconds)) throw new Error(`ffprobe reported no duration: ${probe.stderr}`);
    return seconds;
  }

  it("cuts a branch that runs past the composition, which whole_dur does not", () => {
    // The branch itself ends at 47s: a 5s source delayed by 42s.
    const target = 43.3;

    // `whole_dur` pads *up to* the target and never cuts down to it, so the
    // overrun survives. This is the measurement, not an assertion of intent —
    // if a release ever starts bounding it, this is the line that says so.
    expect(overrunSeconds(`apad=whole_dur=${target}`)).toBeGreaterThan(target + 1);

    // The shipped chain stops at the target on every version measured
    // (7.0.2, 7.1.5, 8.1.2, 9.0.1 all report 43.300000).
    expect(overrunSeconds(buildPadToDurationFilter(String(target)))).toBeCloseTo(target, 2);
  }, 120_000);
});
