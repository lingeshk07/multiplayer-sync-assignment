import React, { useEffect, useRef, useState } from 'react';
import './App.css';
import { createRoom } from './connection';
import type { ConnectionState } from './connection';
import type { Participant } from './protocol';
import { CursorInterpolator, RENDER_DELAY_MS } from './interpolation';
import { drawFrame, pruneReactions } from './render';
import type { ReactionBurst, RemoteCursorView } from './render';

const EMOJIS = ['🎉', '🔥', '👏', '😂', '❤️'];

function getOrCreateClientId(): string {
  const key = 'mp-sync-client-id';
  let id = sessionStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(key, id);
  }
  return id;
}

function getRoomIdFromUrl(): string | null {
  const params = new URLSearchParams(window.location.search);
  const roomId = params.get('room')?.trim();
  return roomId || null;
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const roomRef = useRef<ReturnType<typeof createRoom> | null>(null);
  const interpolators = useRef(new Map<string, CursorInterpolator>());
  const reactionsRef = useRef<ReactionBurst[]>([]);
  const participantsMeta = useRef(new Map<string, { name: string; color: string }>());

  const [selfId] = useState(getOrCreateClientId);
  const [roomId, setRoomId] = useState<string | null>(getRoomIdFromUrl);
  const [roomInput, setRoomInput] = useState(() => getRoomIdFromUrl() ?? '');
  const [roomError, setRoomError] = useState('');
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting');

  // --- Wire up the room connection -------------------------------------
  useEffect(() => {
    if (!roomId) return;

    interpolators.current.clear();
    reactionsRef.current = [];
    participantsMeta.current.clear();
    setParticipants([]);

    const room = createRoom({ roomId, clientId: selfId, name: `guest-${selfId.slice(0, 4)}` });
    roomRef.current = room;

    room.onStateChange(setConnectionState);

    room.onWelcome((_id, initialParticipants) => {
      setParticipants(initialParticipants);
      for (const p of initialParticipants) {
        participantsMeta.current.set(p.clientId, { name: p.name, color: p.color });
        if (p.clientId !== selfId && !interpolators.current.has(p.clientId)) {
          const interp = new CursorInterpolator();
          interp.push({ x: p.x, y: p.y, t: performance.now() });
          interpolators.current.set(p.clientId, interp);
        }
      }
    });

    room.onPresence((list) => {
      setParticipants(list);
      for (const p of list) participantsMeta.current.set(p.clientId, { name: p.name, color: p.color });
    });

    room.onLeave((clientId) => {
      interpolators.current.delete(clientId);
      participantsMeta.current.delete(clientId);
      setParticipants((prev) => prev.filter((p) => p.clientId !== clientId));
    });

    room.onRemoteAction((clientId, action) => {
      if (action.type === 'cursor') {
        let interp = interpolators.current.get(clientId);
        if (!interp) {
          interp = new CursorInterpolator();
          interpolators.current.set(clientId, interp);
        }
        interp.push({ x: action.x, y: action.y, t: performance.now() });
      } else {
        reactionsRef.current.push({
          x: action.x,
          y: action.y,
          emoji: action.emoji,
          startedAt: performance.now(),
        });
      }
    });

    return () => room.close();
  }, [roomId, selfId]);

  // --- Render loop -------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    let raf: number;

    function resize() {
      canvas!.width = canvas!.clientWidth;
      canvas!.height = canvas!.clientHeight;
    }
    resize();
    window.addEventListener('resize', resize);

    function loop() {
      const now = performance.now();
      const renderTime = now - RENDER_DELAY_MS;

      const cursors = new Map<string, RemoteCursorView>();
      for (const [clientId, interp] of interpolators.current) {
        const pos = interp.at(renderTime);
        if (!pos) continue;
        const meta = participantsMeta.current.get(clientId);
        cursors.set(clientId, {
          x: pos.x,
          y: pos.y,
          color: meta?.color ?? '#888',
          name: meta?.name ?? clientId.slice(0, 4),
        });
      }

      reactionsRef.current = pruneReactions(reactionsRef.current, now);
      drawFrame(ctx, canvas!.width, canvas!.height, cursors, reactionsRef.current, now);
      raf = requestAnimationFrame(loop);
    }
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
    };
  }, [roomId]);

  function handleMouseMove(e: React.MouseEvent<HTMLCanvasElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    roomRef.current?.sendAction({ type: 'cursor', x: e.clientX - rect.left, y: e.clientY - rect.top });
  }

  function handleClick(e: React.MouseEvent<HTMLCanvasElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const emoji = EMOJIS[Math.floor(Math.random() * EMOJIS.length)];
    roomRef.current?.sendAction({ type: 'reaction', emoji, x, y });
    // Show our own reaction immediately rather than waiting on the round trip.
    reactionsRef.current.push({ x, y, emoji, startedAt: performance.now() });
  }

  function enterRoom() {
    const nextRoomId = roomInput.trim();
    if (!nextRoomId) {
      setRoomError('Enter a room name to continue.');
      return;
    }
    setRoomError('');
    window.history.replaceState(null, '', `${window.location.pathname}?room=${encodeURIComponent(nextRoomId)}`);
    setRoomId(nextRoomId);
  }

  function leaveRoom() {
    roomRef.current?.close();
    window.history.replaceState(null, '', window.location.pathname);
    setRoomId(null);
    setRoomInput('');
  }

  if (!roomId) {
    return (
      <main className="lobby-shell">
        <section className="lobby-card" aria-labelledby="lobby-title">
          <p className="eyebrow">Live collaboration</p>
          <h1 id="lobby-title">Enter a cursor room</h1>
          <p className="lobby-copy">Create a room for your group, or enter the exact room name to join one already in progress.</p>
          <label className="room-label" htmlFor="room-name">Room name</label>
          <input
            id="room-name"
            value={roomInput}
            onChange={(event) => { setRoomInput(event.target.value); setRoomError(''); }}
            onKeyDown={(event) => { if (event.key === 'Enter') enterRoom(); }}
            placeholder="e.g. design-team"
            autoFocus
          />
          {roomError && <p className="room-error" role="alert">{roomError}</p>}
          <div className="room-actions">
            <button className="primary-button" type="button" onClick={enterRoom}>Create room</button>
            <button className="secondary-button" type="button" onClick={enterRoom}>Join room</button>
          </div>
          <p className="lobby-note">Rooms are separate: only people using the same room name can see one another.</p>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <section className="canvas-panel" aria-label="Live cursor canvas">
        <div className="canvas-heading">
          <div>
            <p className="eyebrow">Live collaboration</p>
            <h1>Cursor studio</h1>
          </div>
          <div className={`connection-badge connection-${connectionState}`}>
            <span aria-hidden="true" />
            {connectionState === 'open' ? 'Connected' : connectionState}
          </div>
        </div>
        <canvas ref={canvasRef} onMouseMove={handleMouseMove} onClick={handleClick} />
        <div className="canvas-hint"><span className="hint-icon">✦</span>Move to share your cursor · Click to send a reaction</div>
      </section>
      <aside className="room-sidebar">
        <header className="sidebar-header">
          <p className="eyebrow">Current room</p>
          <h2>{roomId}</h2>
          <p className="participant-count"><strong>{participants.length}</strong> {participants.length === 1 ? 'person' : 'people'} here</p>
          <button className="change-room-button" type="button" onClick={leaveRoom}>Change room</button>
        </header>
        <section className="participants-section" aria-labelledby="participants-heading">
          <div className="section-title-row"><h3 id="participants-heading">Participants</h3><span>{participants.length}</span></div>
          <ul className="participant-list">
          {participants.map((p) => (
            <li key={p.clientId} className="participant">
              <span className="participant-dot" style={{ background: p.color }} />
              <span className="participant-name">{p.name}</span>
              {p.clientId === selfId && <span className="you-label">You</span>}
            </li>
          ))}
          </ul>
        </section>
      </aside>
    </main>
  );
}
