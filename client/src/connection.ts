import type { ClientMessage, ServerMessage, Participant } from './protocol';
import { isServerMessage } from './protocol';

export interface RoomOptions {
  roomId: string;
  clientId: string;
  mode?: 'create' | 'join';
  name?: string;
  /** Override the WebSocket server URL; otherwise inferred from location + VITE_WS_HOST. */
  url?: string;
}

export type Action =
  | { type: 'cursor'; x: number; y: number }
  | { type: 'reaction'; emoji: string; x: number; y: number };

type RemoteActionHandler = (
  clientId: string,
  action: Action,
  meta: { seq: number; t: number }
) => void;
type PresenceHandler = (participants: Participant[]) => void;
type WelcomeHandler = (clientId: string, participants: Participant[], serverTime: number) => void;
type LeaveHandler = (clientId: string) => void;
export type ConnectionState = 'connecting' | 'open' | 'closed' | 'reconnecting';
type StateHandler = (state: ConnectionState) => void;
type ErrorHandler = (message: string) => void;
type LatencyHandler = (latencyMs: number) => void;

// Cursor throttling: cap outbound rate and skip micro-movements. At low RTT,
// updates are capped at about 30Hz. As the measured RTT grows, the interval
// expands to reduce pressure on an already congested connection.
const CURSOR_MIN_INTERVAL_MS = 33;
const CURSOR_MAX_INTERVAL_MS = 120;
const RTT_TARGET_MS = 100;
const RTT_SMOOTHING = 0.2;
// Coordinates are normalized to 0–1 before sending. 0.002 is roughly 1–2px
// on a typical canvas and avoids sending imperceptibly small movements.
const CURSOR_MIN_DISTANCE = 0.002;

export function createRoom(opts: RoomOptions) {
  const url = opts.url ?? inferDefaultUrl();

  let socket: WebSocket | null = null;
  let state: ConnectionState = 'connecting';
  const sequenceKey = `mp-sync-seq:${opts.clientId}`;
  let seq = Number(sessionStorage.getItem(sequenceKey) ?? '0');
  if (!Number.isSafeInteger(seq) || seq < 0) seq = 0;
  let lastSent = { x: -Infinity, y: -Infinity, t: -Infinity };
  let reconnectAttempt = 0;
  let closedByUser = false;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let connectMode = opts.mode ?? 'join';
  let smoothedRttMs: number | null = null;

  const remoteActionHandlers: RemoteActionHandler[] = [];
  const presenceHandlers: PresenceHandler[] = [];
  const welcomeHandlers: WelcomeHandler[] = [];
  const leaveHandlers: LeaveHandler[] = [];
  const stateHandlers: StateHandler[] = [];
  const errorHandlers: ErrorHandler[] = [];
  const latencyHandlers: LatencyHandler[] = [];

  function setState(s: ConnectionState) {
    state = s;
    stateHandlers.forEach((h) => h(s));
  }

  function connect() {
    setState(reconnectAttempt === 0 ? 'connecting' : 'reconnecting');
    const wsUrl =
      `${url}?roomId=${encodeURIComponent(opts.roomId)}` +
      `&clientId=${encodeURIComponent(opts.clientId)}` +
      `&name=${encodeURIComponent(opts.name ?? '')}` +
      `&mode=${connectMode}`;

    socket = new WebSocket(wsUrl);

    socket.onopen = () => {
      reconnectAttempt = 0;
      setState('open');
      const sendPing = () => send({ type: 'ping', t: Date.now() });
      sendPing();
      pingTimer = setInterval(sendPing, 10000);
    };

    socket.onmessage = (ev) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(ev.data);
      } catch {
        return; // malformed frame: drop silently, don't crash the client
      }
      if (!isServerMessage(parsed)) return;
      dispatch(parsed);
    };

    socket.onclose = () => {
      if (pingTimer) clearInterval(pingTimer);
      setState('closed');
      if (!closedByUser) scheduleReconnect();
    };

    socket.onerror = () => {
      // 'close' always follows 'error' for browser WebSockets; nothing extra to do here.
    };
  }

  function scheduleReconnect() {
    reconnectAttempt++;
    const delay = Math.min(1000 * 2 ** reconnectAttempt, 10000); // capped exponential backoff
    setTimeout(() => {
      if (!closedByUser) connect();
    }, delay);
  }

  function dispatch(msg: ServerMessage) {
    switch (msg.type) {
      case 'welcome':
        // Creating a room is a one-time operation. Every later reconnect must join it.
        connectMode = 'join';
        welcomeHandlers.forEach((h) => h(msg.clientId, msg.participants, msg.serverTime));
        break;
      case 'presence':
        presenceHandlers.forEach((h) => h(msg.participants));
        break;
      case 'cursor':
        remoteActionHandlers.forEach((h) =>
          h(msg.clientId, { type: 'cursor', x: msg.x, y: msg.y }, { seq: msg.seq, t: msg.t })
        );
        break;
      case 'reaction':
        remoteActionHandlers.forEach((h) =>
          h(
            msg.clientId,
            { type: 'reaction', emoji: msg.emoji, x: msg.x, y: msg.y },
            { seq: msg.seq, t: msg.t }
          )
        );
        break;
      case 'leave':
        leaveHandlers.forEach((h) => h(msg.clientId));
        break;
      case 'pong':
        {
          const rttMs = Math.max(0, Date.now() - msg.t);
          smoothedRttMs = smoothedRttMs === null
            ? rttMs
            : smoothedRttMs + (rttMs - smoothedRttMs) * RTT_SMOOTHING;
          const displayedRttMs = smoothedRttMs ?? rttMs;
          latencyHandlers.forEach((h) => h(Math.round(displayedRttMs)));
        }
        break;
      case 'error':
        console.warn('[room] server error:', msg.message);
        closedByUser = true;
        errorHandlers.forEach((h) => h(msg.message));
        break;
    }
  }

  function send(msg: ClientMessage) {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(msg));
    }
  }

  function nextSequence() {
    seq += 1;
    sessionStorage.setItem(sequenceKey, String(seq));
    return seq;
  }

  function cursorIntervalMs() {
    if (smoothedRttMs === null || smoothedRttMs <= RTT_TARGET_MS) {
      return CURSOR_MIN_INTERVAL_MS;
    }
    return Math.min(
      CURSOR_MAX_INTERVAL_MS,
      CURSOR_MIN_INTERVAL_MS + (smoothedRttMs - RTT_TARGET_MS) * 0.25
    );
  }

  function sendAction(action: Action) {
    const now = performance.now();
    if (action.type === 'cursor') {
      const dist = Math.hypot(action.x - lastSent.x, action.y - lastSent.y);
      if (now - lastSent.t < cursorIntervalMs() || dist < CURSOR_MIN_DISTANCE) return;
      lastSent = { x: action.x, y: action.y, t: now };
      send({ type: 'cursor', x: action.x, y: action.y, seq: nextSequence(), t: Date.now() });
    } else {
      // Reactions are discrete/deliberate (a tap), so they're never throttled.
      send({ type: 'reaction', emoji: action.emoji, x: action.x, y: action.y, seq: nextSequence(), t: Date.now() });
    }
  }

  connect();

  return {
    sendAction,
    onRemoteAction(cb: RemoteActionHandler) {
      remoteActionHandlers.push(cb);
    },
    onPresence(cb: PresenceHandler) {
      presenceHandlers.push(cb);
    },
    onWelcome(cb: WelcomeHandler) {
      welcomeHandlers.push(cb);
    },
    onLeave(cb: LeaveHandler) {
      leaveHandlers.push(cb);
    },
    onStateChange(cb: StateHandler) {
      stateHandlers.push(cb);
    },
    onError(cb: ErrorHandler) {
      errorHandlers.push(cb);
    },
    onLatency(cb: LatencyHandler) {
      latencyHandlers.push(cb);
    },
    get connectionState() {
      return state;
    },
    close() {
      closedByUser = true;
      if (pingTimer) clearInterval(pingTimer);
      socket?.close(1000, 'client closed');
    },
  };
}

function inferDefaultUrl(): string {
  if (typeof window === 'undefined') return 'ws://localhost:8080';
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const envHost = (import.meta as any).env?.VITE_WS_HOST as string | undefined;
  const host = envHost ?? `${window.location.hostname}:8080`;
  return `${protocol}://${host}`;
}
