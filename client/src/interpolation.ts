/**
 * Interpolation strategy: fixed render-delay buffer (a.k.a. "entity
 * interpolation" from game netcode).
 *
 * Instead of drawing a remote cursor at its latest known position the
 * instant a message arrives (which snaps/teleports whenever updates are
 * irregular), we render RENDER_DELAY_MS in the past and interpolate
 * between the two buffered samples that bracket that render time. This
 * trades a small, constant amount of added latency for guaranteed
 * smoothness regardless of network jitter — as long as at least two
 * samples have arrived, motion is always a smooth lerp, never a jump.
 *
 * Tradeoff: RENDER_DELAY_MS of latency is added to every remote cursor,
 * on top of network latency. At 100ms this is imperceptible for a
 * "watch cursors move" experience but would be too much for something
 * requiring tight hand-eye sync (e.g. competitive gaming).
 *
 * Bonus: extrapolation. If the render time runs past our newest sample
 * (e.g. the network stalls), we linearly extrapolate from the last known
 * velocity instead of freezing, capped at EXTRAPOLATION_CAP_MS so a long
 * stall doesn't fling the cursor off-screen on stale velocity.
 */

export interface Sample {
  x: number;
  y: number;
  t: number; // local receive timestamp (performance.now()), not the sender's clock
}

const MAX_SAMPLES = 20; // bounds memory per remote cursor regardless of session length
export const RENDER_DELAY_MS = 100;
const EXTRAPOLATION_CAP_MS = 150;

export class CursorInterpolator {
  private samples: Sample[] = [];

  push(sample: Sample) {
    const last = this.samples[this.samples.length - 1];
    if (last && sample.t <= last.t) return; // reject out-of-order arrivals
    this.samples.push(sample);
    if (this.samples.length > MAX_SAMPLES) this.samples.shift();
  }

  /** Interpolated (or extrapolated) position for the given render time, or null if nothing buffered yet. */
  at(renderTime: number): { x: number; y: number } | null {
    const n = this.samples.length;
    if (n === 0) return null;
    if (n === 1) return { x: this.samples[0].x, y: this.samples[0].y };

    for (let i = n - 1; i > 0; i--) {
      const b = this.samples[i];
      const a = this.samples[i - 1];
      if (renderTime <= b.t && renderTime >= a.t) {
        const span = b.t - a.t || 1;
        const f = (renderTime - a.t) / span;
        return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
      }
    }

    const newest = this.samples[n - 1];
    if (renderTime > newest.t) {
      const prev = this.samples[n - 2];
      const dt = newest.t - prev.t || 1;
      const vx = (newest.x - prev.x) / dt;
      const vy = (newest.y - prev.y) / dt;
      const capped = Math.min(renderTime - newest.t, EXTRAPOLATION_CAP_MS);
      return { x: newest.x + vx * capped, y: newest.y + vy * capped };
    }

    // renderTime predates our oldest sample (e.g. right after a join): clamp to it.
    const oldest = this.samples[0];
    return { x: oldest.x, y: oldest.y };
  }

  clear() {
    this.samples = [];
  }
}
