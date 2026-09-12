import type { RawSocket } from './wsocket';
import type { ServerMessage, Participant } from './protocol';

const COLORS = [
  '#F94144', '#F3722C', '#F8961E', '#F9C74F', '#90BE6D',
  '#43AA8B', '#577590', '#277DA1', '#9B5DE5', '#F15BB5',
];

interface ClientState {
  id: string;
  name: string;
  color: string;
  socket: RawSocket;
  lastCursorSeq: number;
  lastReactionSeq: number;
  x: number;
  y: number;
  alive: boolean;
}

/**
 * All state for a single room lives here. The server owns: identity
 * (clientId -> color/name), last-known cursor position (for snapshotting
 * new joiners), and per-client sequence numbers (for discarding stale
 * out-of-order updates). Everything else — the actual interpolation,
 * rendering, throttling — is the client's job; the server just relays.
 */
export class Room {
  private clients = new Map<string, ClientState>();
  private colorIdx = 0;

  get size() {
    return this.clients.size;
  }

  /**
   * Adds a new client, or, if `id` already has a live entry (reconnect
   * case), swaps in the new socket while preserving identity/state so the
   * client doesn't get a duplicate cursor or lose its color.
   */
  join(id: string, name: string, socket: RawSocket): ClientState {
    const existing = this.clients.get(id);
    if (existing) {
      existing.socket = socket;
      existing.alive = true;
      return existing;
    }
    const state: ClientState = {
      id,
      name,
      color: COLORS[this.colorIdx++ % COLORS.length],
      socket,
      lastCursorSeq: -1,
      lastReactionSeq: -1,
      x: 0,
      y: 0,
      alive: true,
    };
    this.clients.set(id, state);
    return state;
  }

  /**
   * Removes the client only if `socket` is still its current transport.
   * This guards against a race where an old socket's 'close' event fires
   * *after* the client has already reconnected on a new socket.
   */
  leaveIfCurrentSocket(id: string, socket: RawSocket): boolean {
    const c = this.clients.get(id);
    if (!c || c.socket !== socket) return false;
    this.clients.delete(id);
    return true;
  }

  markAlive(id: string) {
    const c = this.clients.get(id);
    if (c) c.alive = true;
  }

  /** Applies a cursor update if newer than the last one seen; returns false if it was stale/out-of-order. */
  applyCursor(id: string, x: number, y: number, seq: number): boolean {
    const c = this.clients.get(id);
    if (!c || seq <= c.lastCursorSeq) return false;
    c.lastCursorSeq = seq;
    c.x = x;
    c.y = y;
    return true;
  }

  /** Same idea as applyCursor, tracked on a separate sequence stream (reactions are discrete, cursor moves are continuous). */
  applyReaction(id: string, seq: number): boolean {
    const c = this.clients.get(id);
    if (!c || seq <= c.lastReactionSeq) return false;
    c.lastReactionSeq = seq;
    return true;
  }

  participants(): Participant[] {
    return [...this.clients.values()].map((c) => ({
      clientId: c.id,
      name: c.name,
      x: c.x,
      y: c.y,
      color: c.color,
    }));
  }

  broadcast(msg: ServerMessage, excludeId?: string) {
    const data = JSON.stringify(msg);
    for (const c of this.clients.values()) {
      if (c.id === excludeId) continue;
      try {
        c.socket.send(data);
      } catch {
        // Best-effort; a dead socket will be reaped by the heartbeat sweep.
      }
    }
  }

  send(id: string, msg: ServerMessage) {
    const c = this.clients.get(id);
    if (!c) return;
    try {
      c.socket.send(JSON.stringify(msg));
    } catch {
      /* ignore */
    }
  }

  /**
   * Heartbeat sweep, called on a fixed interval. Any client that hasn't
   * pong'd since the *previous* sweep is dropped (it missed one full
   * heartbeat interval); everyone still alive is pinged and flagged
   * not-alive until their next pong arrives. This bounds disconnect
   * detection to roughly one heartbeat interval.
   */
  sweep(onDrop: (id: string) => void) {
    for (const c of [...this.clients.values()]) {
      if (!c.alive) {
        this.clients.delete(c.id);
        onDrop(c.id);
        continue;
      }
      c.alive = false;
      try {
        c.socket.ping();
      } catch {
        /* ignore */
      }
    }
  }
}
