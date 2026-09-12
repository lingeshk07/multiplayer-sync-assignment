# Real-Time Multiplayer Cursor/State Sync

A raw-WebSocket, from-scratch sync engine: shared cursors + tap-to-react emoji bursts,
live across as many browser tabs as you open. No Socket.IO, no `ws`, no sync framework —
the server implements the WebSocket handshake and frame protocol itself on top of Node's
built-in `http`/`net`/`crypto`, and the client uses the browser's native `WebSocket`.

## Setup

```bash
# terminal 1 — server
cd server
npm install
npm run dev          # ws://localhost:8080

# terminal 2 — client
cd client
npm install
npm run dev           # http://localhost:5173
```

Open `http://localhost:5173`, enter a room name, and choose **Create room**. Other
participants enter that exact name and choose **Join room**. Rooms are isolated: only
participants in the same active room see one another. A room is removed after its final
participant leaves, so it must be created again before it can be joined.

Each newly opened tab receives its own client identity, including browser-duplicated tabs.
Refreshing a tab preserves that tab's identity so it can reconnect without a duplicate cursor.

Move your mouse over the canvas to broadcast your cursor; click to fire a reaction.
The sidebar shows live presence and connection status.

**Type-checking:** `npm run typecheck` works in both `server/` and `client/` and passes
clean (verified as part of building this).

**Integration test:** from `server/`, run `npm run test:integration`. It starts a temporary
local server and verifies room create/join rejection rules, five simultaneous clients,
presence, cursor relay, reaction relay, and leave cleanup.

## Deployment configuration

The client derives its WebSocket URL from the page protocol and `VITE_WS_HOST`. For local
development it connects to `ws://localhost:8080`. For a deployed HTTPS client, set
`VITE_WS_HOST` to the WebSocket server hostname only (for example,
`my-server.onrender.com`); the client then uses `wss://` automatically. The WebSocket
server must run on a host that supports persistent WebSocket connections.

## Known limitations

- No authentication or per-room access control (shared public room IDs, per the assignment).
- No persistence — server restart drops all rooms and presence.
- Single process, in-memory state — see `ARCHITECTURE.md` for a horizontal-scaling sketch.
- The hand-rolled WebSocket server does not reassemble fragmented (continuation-frame)
  messages. Every message here is a small JSON object well under what a browser would
  ever split across frames automatically, so this hasn't been an issue in testing, but
  a client sending a deliberately fragmented frame would be mishandled.
- No binary frame support (not needed — everything is JSON text).
- A dropped connection is detected on the heartbeat sweep after it misses a
  control-frame pong. Depending on when the drop occurs, that takes about 15–30s;
  then the server removes the client and forcibly destroys its unresponsive TCP
  socket. A reverse proxy or browser still controls the client-side TCP behavior.

## Time spent

Roughly a day-equivalent of focused work, most of it on the hand-rolled WebSocket
transport (handshake + frame encode/decode) and getting the interpolation buffer's
edge cases (0/1/many samples, extrapolation cap, out-of-order rejection) right.

## AI tool disclosure

Codex  later used toreview the assignment against the final code, improve the UI and room workflow, tighten
runtime validation, add the five-client integration test, add adaptive throttling,
reaction reconciliation, explicit TCP no-delay handling for small WebSocket frames, and
run type-check/build
verification. The final implementation was reviewed and tested locally; I can explain
and defend each file and design decision.

---

## Protocol design

All message types live in `shared/protocol.ts`, re-exported into both `server/src/protocol.ts`
and `client/src/protocol.ts`. TypeScript's discriminated unions define the shapes; the
`isClientMessage`/`isServerMessage` runtime guards enforce them at the JSON boundary,
where static types provide zero real protection — any client message that fails
validation gets an `{ type: 'error' }` reply instead of being silently accepted or
crashing the connection.

### Client → Server

| Type | Shape | Notes |
|---|---|---|
| `cursor` | `{ type, x, y, seq, t }` | `x`/`y` are normalized 0–1 coordinates; throttled client-side. |
| `reaction` | `{ type, emoji, x, y, seq, t }` | Normalized coordinates; one per tap, never throttled. |
| `ping` | `{ type, t }` | Sent on connect and every 10 seconds to measure round-trip latency. It is not used for liveness. |

### Server → Client

| Type | Shape | Notes |
|---|---|---|
| `welcome` | `{ type, clientId, participants, serverTime }` | Sent once, right after join/reconnect. Full snapshot with normalized cursor positions. |
| `presence` | `{ type, participants }` | Sent to everyone else when someone joins. |
| `cursor` | `{ type, clientId, x, y, seq, t }` | Normalized coordinates, relayed excluding the sender. |
| `reaction` | `{ type, clientId, emoji, x, y, seq, t }` | Normalized coordinates, relayed excluding the sender. |
| `leave` | `{ type, clientId }` | On clean close or heartbeat timeout. |
| `pong` | `{ type, t }` | Echoes the client's `ping.t`. |
| `error` | `{ type, message }` | Malformed/unknown client message. |

Room, client identity, and intent are carried in the WebSocket URL's query string
(`?roomId=...&clientId=...&name=...&mode=create|join`) rather than in a `join` message,
since the server needs them to route the upgrade *before* any message frame can arrive.
`create` rejects an already-active name; `join` rejects a room that does not exist. A
repeat `create` from the same tab identity is accepted as a reconnect, which handles a
development-mode remount or an accidental double click without admitting a second user.

### Throttling / batching high-frequency updates

Raw `mousemove` fires at 60-120Hz depending on hardware — sending every event is wasted
bandwidth for output that's displayed at most 60fps on the receiving end. `connection.ts`
caps outbound cursor sends at ~30Hz when RTT is at or below 100ms
(`CURSOR_MIN_INTERVAL_MS = 33`) and skips movements smaller than 0.002 of the canvas
dimension (roughly 1–2 pixels on a typical canvas). The client smooths RTT readings from
`pong` messages; above 100ms it increases the cursor-send interval gradually, up to 120ms,
to avoid worsening a congested connection. Reactions are discrete user intent and are
never throttled — each one is still sent to the server as a separate meaningful event.

### Simultaneous reactions

Reactions do not overwrite each other: the server relays every accepted reaction using
its own per-client reaction sequence stream. For readability, each client reconciles
reactions that arrive within 250ms and within 0.035 normalized canvas units of one
another into one animated burst labeled `×N`. This is presentation-only; the count makes
simultaneous taps on the same target visible without hiding their multiplicity.

### What lives on the server vs. is purely relayed

The server is the source of truth for **room membership and each client's last-known
cursor position** (needed to snapshot new joiners) and **per-client sequence numbers**
(needed to reject stale/out-of-order updates). Everything else — interpolation,
rendering, reaction animation, throttling decisions — is pure client concern; the server
never touches pixels or timing beyond relaying the sender's own timestamp.

Coordinates are normalized to the 0–1 range before they leave the browser and validated
on the server. Each viewer scales them to its own canvas size, so cursors align by
relative position even when participants have differently sized windows.

---

## Interpolation strategy

**Fixed render-delay buffer** ("entity interpolation," the standard game-netcode
technique): the client always draws remote cursors `RENDER_DELAY_MS = 100ms` in the
past, interpolating linearly between the two buffered samples that bracket that render
time (`client/src/interpolation.ts`). Because we're always drawing *between* two already-
received points rather than jumping to the newest one, motion is smooth by construction
regardless of how irregular the network delivery is — there's no special case for "the
gap between updates was unusually large," it's the same lerp either way.

**Tradeoff:** every remote cursor is rendered ~100ms behind the sender's real position,
on top of one-way network latency. That's the price of guaranteed smoothness. For a
"watch cursors move together" experience this is imperceptible; it would be too much
added lag for anything requiring tight hand-eye coordination (e.g. a fast-paced
competitive game), where you'd want to lean more on extrapolation instead.

**Bonus — extrapolation:** if the render time runs past the newest buffered sample (the
network stalled), the client linearly extrapolates from the last known velocity instead
of freezing the cursor, capped at 150ms so a long stall can't fling it far off-screen on
stale velocity data.

**Bounded memory:** each remote cursor's sample buffer is capped at 20 entries
(`MAX_SAMPLES`) — old samples are dropped as new ones arrive, so buffer size is constant
regardless of session length, not "every historical position forever."

---

## Failure handling

**Out-of-order delivery:** every `cursor`/`reaction` message carries a per-client,
per-action-type `seq` counter. The server (`room.ts`) tracks the last-accepted `seq` per
client and silently discards anything ≤ that value before broadcasting — a stale update
that arrives late (e.g. after a network reorder) never overwrites a newer one. The
client's interpolation buffer does the same locally on its own receive-time samples, in
case buffering/replay ever produces an out-of-order `push`.

**Malformed messages:** any client message that isn't valid JSON, or doesn't match one
of the known `ClientMessage` shapes (checked field-by-field via `isClientMessage`), gets
a `{ type: 'error' }` reply and is otherwise ignored — never silently accepted, never a
thrown exception that could crash the connection or the process. Client-side
`isServerMessage` also validates every received server message, including each participant
inside a `welcome` or `presence` snapshot, before it reaches UI state.

**Disconnect (clean or dropped):** the server pings every connected client every 15s. A
client that does not pong before the *next* sweep is dropped, its TCP socket is forcibly
destroyed, and a `leave` is broadcast. A hard network drop therefore remains visible for
about 15–30 seconds, depending on when it occurs relative to the sweep. A clean
tab-close/`socket.close()` is handled immediately via the `close` frame instead of
waiting for the next sweep.

**Small-frame latency:** the upgraded server TCP socket explicitly uses `setNoDelay(true)`.
This prevents Nagle batching from holding server-originated cursor, reaction, or ping/pong
frames. It improves the Node-server leg only; it cannot remove latency caused by the
browser, a reverse proxy, geographic distance, or server load.

**Connection feedback:** the sidebar shows live round-trip latency calculated from the
application `ping`/`pong` timestamp, starting immediately after the socket opens and
refreshing every 10 seconds. Server-side connection errors remain visible with a Retry
button instead of silently sending the user back to the room-selection screen.

**Reconnect:** the client keeps a tab identity in `sessionStorage` and reuses it on a
page refresh or automatic WebSocket reconnect. A newly opened or browser-duplicated tab
gets a new identity, preventing it from replacing another live tab. Server-side,
`Room.join()` recognizes an existing `clientId` and swaps in the new socket rather than
creating a second entry. `Room.leaveIfCurrentSocket()` guards against a subtle race: if
the old socket closes after a reconnect, it must not delete the fresh connection.

**Broadcast fan-out:** `Room.broadcast()` iterates the room's client map once per
message (O(n) in room size, not O(n²)) and always excludes the sender — no client ever
receives an echo of its own action.

---

For architecture and code-organization notes (transport vs. protocol vs. rendering
separation, and the scaling discussion), see `ARCHITECTURE.md`.
