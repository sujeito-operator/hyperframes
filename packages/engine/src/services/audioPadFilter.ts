/**
 * Pad-to-duration filter chain, shared by every audio path that has to hold a
 * stream to the composition's length.
 *
 * Two live call sites build this chain — the engine mixer and the producer's
 * pad/trim step — plus the producer's audio extractor, which carries
 * `fallow-ignore-file unused-file` and has no importers. Before this module
 * each rebuilt the string by hand, so a fix in one did not reach the others.
 *
 * ## Why the chain is three filters and not one
 *
 * `apad` with no duration pads indefinitely; the trailing `atrim` is what
 * bounds it. That pairing is deliberate: `apad=whole_dur=<seconds>` says the
 * same thing in one filter, but the bundled Windows FFmpeg builds reject the
 * option outright (`Error applying option 'whole_dur': Option not found`), and
 * it does not bound a branch that is already *longer* than the target — an FX
 * tail that overruns the composition survives `whole_dur` and is cut by
 * `atrim`.
 *
 * On the FFmpeg 7.x line, however, `atrim` reading `apad`'s output timestamps
 * directly is what broke the mix: audio leaked to `t=0` from three mixed
 * branches onward, and from four branches onward the branch with the largest
 * `adelay` vanished from the output entirely. Nothing errored.
 *
 * The affected window is 7.x specifically, not "7 and newer". Measured on a
 * five-branch mix, `apad,atrim` alone leaks and drops on 7.0.2 and on 7.1.5
 * (the tail of that line) and is correct on 4.2.7, 6.0.1, 8.1.2 and 9.0.1.
 * `ffmpeg-static` is only a dependency of `packages/aws-lambda` and
 * `findFfBinary` falls through to `PATH`, so the exposed population is users
 * whose system FFmpeg is 7.x — which is why this is worth fixing even though
 * no CI lane pins a 7.x binary to catch it.
 *
 * `asetpts=N/SR/TB` between them rebuilds each frame's timestamp from the
 * running sample count, so `atrim` sees a monotonic sample-accurate timeline
 * instead of whatever the release propagates through an indefinite `apad`.
 * The output is then sample-for-sample what `apad=whole_dur` produces on every
 * version above — without giving up the `atrim` bound or the Windows builds.
 *
 * @param seconds Target duration, already formatted for a filter string by the
 *   caller. Each call site has its own number formatting and this helper must
 *   not silently change it.
 */
export function buildPadToDurationFilter(seconds: string): string {
  return `apad,asetpts=N/SR/TB,atrim=0:${seconds}`;
}
