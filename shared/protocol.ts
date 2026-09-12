/**
 * Wire protocol shared between client and server.
 *
 * Design notes:
 * - Every message is a small, flat JSON object with a `type` discriminant.
 * - `seq` is a per-client, per-action monotonically increasing counter used
 *   to detect and discard out-of-order / stale updates (see room.ts).
 * - `t` is the sender's local timestamp (ms) at the moment the action was
 *   produced. It's used client-side for interpolation, not for ordering
 *   (ordering is seq's job, since clocks aren't synchronized).
 */

export interface Participant {
  clientId: string;
  name: string;
  x: number;
  y: number;
  color: string;
}

// ---- Client -> Server -------------------------------------------------

export type ClientMessage =
  | { type: 'cursor'; x: number; y: number; seq: number; t: number }
  | { type: 'reaction'; emoji: string; x: number; y: number; seq: number; t: number }
  | { type: 'ping'; t: number };

// ---- Server -> Client -------------------------------------------------

export type ServerMessage =
  | { type: 'welcome'; clientId: string; participants: Participant[]; serverTime: number }
  | { type: 'presence'; participants: Participant[] }
  | { type: 'cursor'; clientId: string; x: number; y: number; seq: number; t: number }
  | { type: 'reaction'; clientId: string; emoji: string; x: number; y: number; seq: number; t: number }
  | { type: 'leave'; clientId: string }
  | { type: 'pong'; t: number }
  | { type: 'error'; message: string };

// ---- Runtime validation -------------------------------------------------
// Unknown/malformed messages must be rejected rather than silently accepted
// or allowed to crash either side. These act as type guards at the JSON
// boundary, where TypeScript's static types provide no real protection.

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export function isClientMessage(obj: unknown): obj is ClientMessage {
  if (typeof obj !== 'object' || obj === null) return false;
  const o = obj as Record<string, unknown>;
  switch (o.type) {
    case 'cursor':
      return (
        isFiniteNumber(o.x) && isFiniteNumber(o.y) && isFiniteNumber(o.seq) && isFiniteNumber(o.t)
      );
    case 'reaction':
      return (
        typeof o.emoji === 'string' &&
        o.emoji.length > 0 &&
        o.emoji.length <= 8 &&
        isFiniteNumber(o.x) &&
        isFiniteNumber(o.y) &&
        isFiniteNumber(o.seq) &&
        isFiniteNumber(o.t)
      );
    case 'ping':
      return isFiniteNumber(o.t);
    default:
      return false;
  }
}

export function isServerMessage(obj: unknown): obj is ServerMessage {
  if (typeof obj !== 'object' || obj === null) return false;
  const o = obj as Record<string, unknown>;
  switch (o.type) {
    case 'welcome':
      return typeof o.clientId === 'string' && Array.isArray(o.participants) && isFiniteNumber(o.serverTime);
    case 'presence':
      return Array.isArray(o.participants);
    case 'cursor':
      return (
        typeof o.clientId === 'string' &&
        isFiniteNumber(o.x) &&
        isFiniteNumber(o.y) &&
        isFiniteNumber(o.seq) &&
        isFiniteNumber(o.t)
      );
    case 'reaction':
      return (
        typeof o.clientId === 'string' &&
        typeof o.emoji === 'string' &&
        isFiniteNumber(o.x) &&
        isFiniteNumber(o.y) &&
        isFiniteNumber(o.seq) &&
        isFiniteNumber(o.t)
      );
    case 'leave':
      return typeof o.clientId === 'string';
    case 'pong':
      return isFiniteNumber(o.t);
    case 'error':
      return typeof o.message === 'string';
    default:
      return false;
  }
}
