import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * The pad-to-duration chain is built in exactly one place.
 *
 * Three sites used to assemble `apad,atrim=0:<total>` by hand — the engine
 * mixer, the producer's pad/trim step, and the producer's audio extractor — so
 * the FFmpeg 7.x timestamp fix had to be made three times or it was not made.
 * `buildPadToDurationFilter` exists to end that, and a helper only ends it for
 * as long as nobody writes the string out again.
 *
 * Pinning the three current call sites individually would not close the loop;
 * a fourth site added next month is exactly the case that produced this bug.
 * So this DISCOVERS the offenders instead: after stripping comments, the
 * literal `apad` may appear in one file, and every other pad site must reach
 * it through the helper.
 *
 * The manifest below runs the check the other way. If a sweep-root change or
 * an extension tweak drops a known file out of discovery, the sweep goes quiet
 * and stays green — the silent-vacuum failure `ffprobeArgvContract.test.ts`
 * documents for the ffprobe terminator. Discovery is authoritative for finding
 * NEW offenders; the manifest is what proves discovery still runs.
 */
const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");

const SWEEP_ROOTS = ["packages", "skills", "scripts"];
const SOURCE_EXT = /\.(?:ts|mts|cts|mjs|cjs|js)$/;
const SKIP_DIR = new Set(["node_modules", "dist", "build", ".git", "coverage", "tests"]);

/** The one file allowed to spell the chain out. */
const CHAIN_OWNER = "packages/engine/src/services/audioPadFilter.ts";

/**
 * Files that pad a stream to the composition duration and must therefore call
 * the helper. Not the discovery input — the proof that discovery still sees
 * the tree it is supposed to be sweeping.
 */
const PAD_CALL_SITES = [
  "packages/engine/src/services/audioMixer.ts",
  "packages/producer/src/services/audioExtractor.ts",
  "packages/producer/src/services/render/audioPadTrim.ts",
];

/**
 * Comments only. `apad` shows up in prose in every one of these files —
 * that is the point of the prose — and a check that cannot tell a filter
 * string from an explanation of one would fail on its own documentation.
 */
function stripComments(source: string): string {
  return source.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/\/\/[^\n]*/g, "");
}

function collectSources(directory: string, files: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIR.has(entry.name)) collectSources(entryPath, files);
    } else if (entry.isFile() && SOURCE_EXT.test(entry.name)) {
      files.push(entryPath);
    }
  }
  return files;
}

const sources = SWEEP_ROOTS.flatMap((root) => collectSources(join(REPO_ROOT, root))).map(
  (absolutePath) => ({
    relPath: relative(REPO_ROOT, absolutePath).replaceAll("\\", "/"),
    absolutePath,
  }),
);

describe("pad-to-duration chain contract", () => {
  it("sweeps a tree that actually contains the pad call sites", () => {
    // Guards the sweep itself: roots, extensions and skip list all have to
    // still reach the files the rest of this suite reasons about.
    const found = new Set(sources.map((file) => file.relPath));
    expect([...PAD_CALL_SITES, CHAIN_OWNER].filter((path) => !found.has(path))).toEqual([]);
  });

  it("spells the chain out in exactly one file", () => {
    const offenders = sources
      .filter(({ relPath }) => relPath !== CHAIN_OWNER && !relPath.includes(".test."))
      .filter(({ absolutePath }) =>
        stripComments(readFileSync(absolutePath, "utf8")).includes("apad"),
      )
      .map(({ relPath }) => relPath);

    expect(
      offenders,
      "these build a pad chain by hand — call buildPadToDurationFilter instead",
    ).toEqual([]);
  });

  it("routes every pad call site through the helper", () => {
    const missing = PAD_CALL_SITES.filter(
      (relPath) =>
        !/buildPadToDurationFilter\s*\(/.test(readFileSync(join(REPO_ROOT, relPath), "utf8")),
    );

    expect(missing, "pads to a duration without the shared helper").toEqual([]);
  });

  it("keeps whole_dur out of the shipped chain", () => {
    // The bundled Windows FFmpeg builds reject the option outright, and it
    // does not bound an FX tail that already overruns the composition. Both
    // are measured in audioMixer.padTimestamps.integration.test.ts.
    const offenders = sources
      .filter(({ relPath }) => !relPath.includes(".test."))
      .filter(({ absolutePath }) =>
        stripComments(readFileSync(absolutePath, "utf8")).includes("whole_dur"),
      )
      .map(({ relPath }) => relPath);

    expect(offenders, "whole_dur is rejected by the bundled Windows builds").toEqual([]);
  });
});
