import http from 'http';
import { randomUUID } from 'crypto';
import { performHandshake } from './wsocket';
import { Room } from './room';
import { isClientMessage } from './protocol';

const PORT = Number(process.env.PORT) || 8080;
const HEARTBEAT_INTERVAL_MS = 15000; // disconnects are detected within ~1 interval

const rooms = new Map<string, Room>();

function createRoom(roomId: string): Room {
  let room = rooms.get(roomId);
  if (!room) {
    room = new Room();
    rooms.set(roomId, room);
  }
  return room;
}

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('multiplayer-sync server ok\n');
});

server.on('upgrade', (req, socket) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const roomId = url.searchParams.get('roomId') || 'default';
  const mode = url.searchParams.get('mode') === 'create' ? 'create' : 'join';
  const clientId = url.searchParams.get('clientId') || randomUUID();
  const name = url.searchParams.get('name') || `guest-${clientId.slice(0, 4)}`;

  const raw = performHandshake(req, socket);
  if (!raw) return;

  const existingRoom = rooms.get(roomId);
  if (mode === 'join' && !existingRoom) {
    raw.send(JSON.stringify({ type: 'error', message: 'This room does not exist. Create it first or check the room name.' }));
    raw.close(1008, 'room not found');
    return;
  }
  // React development mode may briefly open the same tab's connection twice.
  // Treat a repeated create from that same stable client identity as a reconnect,
  // while still rejecting a different client attempting to create an active room.
  if (mode === 'create' && existingRoom && !existingRoom.hasClient(clientId)) {
    raw.send(JSON.stringify({ type: 'error', message: 'This room already exists. Use Join room instead.' }));
    raw.close(1008, 'room already exists');
    return;
  }

  const room = existingRoom ?? createRoom(roomId);
  room.join(clientId, name, raw);

  // New joiner (or reconnecting client) gets a full snapshot of current
  // participants — simpler and cheaper than replaying history for a room
  // this small, and it means their view is correct immediately rather than
  // "eventually correct after enough updates arrive".
  room.send(clientId, {
    type: 'welcome',
    clientId,
    participants: room.participants(),
    serverTime: Date.now(),
  });

  // Everyone else just needs to know presence changed; they'll pick up
  // this client's cursor from the next 'cursor' broadcast.
  room.broadcast({ type: 'presence', participants: room.participants() }, clientId);

  raw.onText((text) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      room.send(clientId, { type: 'error', message: 'invalid json' });
      return;
    }

    if (!isClientMessage(parsed)) {
      room.send(clientId, { type: 'error', message: 'unknown or malformed message type' });
      return;
    }

    switch (parsed.type) {
      case 'cursor':
        if (room.applyCursor(clientId, parsed.x, parsed.y, parsed.seq)) {
          // Never echo a client's own action back to itself.
          room.broadcast(
            { type: 'cursor', clientId, x: parsed.x, y: parsed.y, seq: parsed.seq, t: parsed.t },
            clientId
          );
        }
        break;
      case 'reaction':
        if (room.applyReaction(clientId, parsed.seq)) {
          room.broadcast(
            {
              type: 'reaction',
              clientId,
              emoji: parsed.emoji,
              x: parsed.x,
              y: parsed.y,
              seq: parsed.seq,
              t: parsed.t,
            },
            clientId
          );
        }
        break;
      case 'ping':
        room.send(clientId, { type: 'pong', t: parsed.t });
        break;
    }
  });

  raw.onPong(() => room.markAlive(clientId));

  raw.onClose(() => {
    if (room.leaveIfCurrentSocket(clientId, raw)) {
      room.broadcast({ type: 'leave', clientId });
      if (room.size === 0) rooms.delete(roomId);
    }
  });
});

// Heartbeat: prune dead connections and empty rooms on a fixed cadence.
// This, plus the 'close' handler above, are the two ways a client leaves —
// 'close' handles the clean/fast case, this handles dropped connections
// that never sent a close frame.
setInterval(() => {
  for (const [roomId, room] of [...rooms]) {
    room.sweep((droppedId) => room.broadcast({ type: 'leave', clientId: droppedId }));
    if (room.size === 0) rooms.delete(roomId);
  }
}, HEARTBEAT_INTERVAL_MS);

server.listen(PORT, () => {
  console.log(`multiplayer-sync server listening on ws://localhost:${PORT}`);
});
