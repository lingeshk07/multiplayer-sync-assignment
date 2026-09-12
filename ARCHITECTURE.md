# Architecture

## Layers

```
shared/protocol.ts        message types + runtime validators (imported by both sides)

server/src/
  wsocket.ts               TRANSPORT — raw WebSocket handshake + frame encode/decode.
                            Enables TCP no-delay for latency-sensitive small frames;
                            knows nothing about rooms, cursors, or JSON contents.
  protocol.ts               re-exports shared/protocol.ts
  room.ts                  STATE — room membership, last-known cursor, sequence
                            numbers, broadcast fan-out, heartbeat sweep.
                            Knows nothing about the WebSocket wire format.
  server.ts                WIRING — HTTP server, upgrade handling, routes validated
                            protocol messages to Room methods. The only file that
                            knows about transport, protocol, and rooms all at once.

client/src/
  connection.ts            TRANSPORT + PROTOCOL — wraps native WebSocket, exposes
                            createRoom()/sendAction()/onRemoteAction(), throttles
                            normalized cursor updates adaptively from smoothed RTT,
                            measures RTT with ping/pong, and handles reconnect backoff.
  interpolation.ts          RECONCILIATION — buffers remote samples, produces smooth
                            interpolated/extrapolated positions. No DOM, no canvas,
                            no WebSocket knowledge.
  render.ts                 RENDERING — pure canvas-drawing functions. Takes normalized
                            {x,y,color,name} view objects, scales them to the current
                            canvas, and reconciles overlapping reaction bursts.
  App.tsx                   Glue: wires connection → interpolators → render loop,
                            plus the create/join lobby, presence sidebar, latency/error
                            feedback, and reaction click handler.
```

Each layer only talks to the one below it through a narrow interface (plain objects,
callbacks) — `room.ts` never imports `wsocket.ts`'s frame-encoding internals, just the
`RawSocket` interface (`send`/`ping`/`close`/`onText`/`onClose`/`onPong`);
`interpolation.ts` and `render.ts` have zero networking imports at all.

## Room lifecycle and identity

The server owns a `Map<roomId, Room>`. Clients connect with explicit `mode=create` or
`mode=join` query parameters. A join to an unknown room is rejected, while a create for
an active room is rejected unless it is the same stable client identity reconnecting.
When the final participant leaves, the room is deleted from the map.

The client preserves its identity across a refresh and automatic reconnect. It generates
a new identity for a newly opened or duplicated browser tab, so two tabs do not replace
each other's WebSocket connection. Cursor and reaction coordinates are normalized to
`0..1`, validated by the server, and scaled to each local canvas at render time.

## Congestion and simultaneous-action handling

The client derives a smoothed RTT from application `ping`/`pong` messages. It sends
cursor updates every 33ms under 100ms RTT, then expands the interval proportionally up
to 120ms as RTT rises. This is deliberately a client-side bandwidth decision; the server
continues to relay each valid update without trying to predict network conditions.

Reactions are not throttled or discarded. A per-client reaction sequence stream means
two clients can tap at the same time without one action replacing the other. The renderer
coalesces reactions that are close in position and within a 250ms window into a single
burst with a `×N` label. This makes the simultaneous result legible while preserving the
number of accepted reaction events.

## Extensibility: adding a new action type

Say you wanted to add, e.g., a `drag-select` action. The change is fully contained to
the protocol and reconciliation layers:

1. Add the shape to `ClientMessage`/`ServerMessage` in `shared/protocol.ts` and extend
   `isClientMessage`/`isServerMessage`.
2. Add a case in `server.ts`'s message switch (broadcast it, maybe track last-known
   state in `Room` if new joiners need to see it).
3. Add a case in `connection.ts`'s `dispatch()` to surface it via `onRemoteAction`.
4. Add rendering logic in `render.ts` and drive it from `App.tsx`.

**Nothing in `wsocket.ts` changes.** The transport layer only ever sees opaque text
frames; it has no concept of message *types* at all. That's the point of keeping
framing and protocol semantics as separate files — a new action type is a protocol- and
application-layer change, never a transport-layer one.

## Server correctness notes

- **Broadcast fan-out** is O(n) per message (`Room.broadcast` iterates the client map
  once), not O(n²). At the 3-10 client scale this assignment targets, this is
  overwhelmingly good enough; see the scaling section below for where it'd start to
  matter.
- **No self-echo**: every `broadcast()` call from `server.ts` passes the sender's
  `clientId` as the exclude parameter.
- **Heartbeat** uses the raw `ping`/`pong` opcodes (0x9/0xA) that `wsocket.ts` exposes,
  not an application-level "are you there" message. Separately, the client sends an
  application `ping` on connect and every 10 seconds; the echoed `pong` supplies the
  latency value shown in the UI.
- **Small-frame transport:** after a successful upgrade, the server calls
  `socket.setNoDelay(true)`. This prevents Node's TCP stack from applying Nagle batching
  to server-originated cursor, reaction, heartbeat, and latency-pong frames. Browser and
  reverse-proxy behavior remains outside the application's control.

## Horizontal scaling (discussion only — not implemented)

The current design is a single process holding all room state in memory
(`Map<roomId, Room>`), which is honest and correct for the assignment's target of a
handful of concurrent clients in one room. Scaling beyond one process means:

1. **Sticky sessions or a shared pub/sub backplane.** A client's WebSocket is pinned to
   whichever server instance accepted the upgrade. For clients in the *same room* to see
   each other's cursors across instances, either (a) route by room ID at the load
   balancer so a whole room always lands on one instance (simple, but a single busy room
   can't scale past one box), or (b) keep per-instance client connections but relay
   `cursor`/`reaction` messages between instances via a pub/sub layer (Redis pub/sub,
   NATS, etc.) keyed by room ID — each instance subscribes to the rooms it has local
   clients for and re-broadcasts to them.
2. **Room state ownership.** `Room`'s in-memory `Map` (participants, last cursor
   position, sequence numbers) would need to live in a shared store (Redis, or a
   lightweight actor/room-owner service) if any client in a room could connect to any
   instance — otherwise "who's the last-cursor-seq authority for this client" becomes
   ambiguous across instances.
3. **Heartbeat/reconnect semantics don't change** — they're already per-connection and
   would work the same whether that connection's server process is the same one across
   reconnects or not, as long as `Room.join()`'s identity-preserving logic is backed by
   the shared store rather than local memory.
4. **The transport layer (`wsocket.ts`) is untouched by any of this** — scaling is
   entirely a state/room-ownership problem, not a "how do we parse WebSocket frames
   across machines" problem.

For this assignment's explicit scope (3-10 clients, single room, no auth), none of this
was necessary to implement — but the layering above (transport / room-state / wiring) is
what makes it a scoped follow-up rather than a rewrite.
