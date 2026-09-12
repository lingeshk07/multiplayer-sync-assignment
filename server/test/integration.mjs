import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const port = 18081;
const baseUrl = `ws://127.0.0.1:${port}`;
const inboxes = new WeakMap();
const server = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/server.ts'], {
  env: { ...process.env, PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverErrorOutput = '';
server.stderr.on('data', (chunk) => { serverErrorOutput += chunk.toString(); });

function waitForServer() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`server did not start${serverErrorOutput ? `:\n${serverErrorOutput}` : ''}`)),
      5000
    );
    server.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('listening on')) {
        clearTimeout(timer);
        resolve();
      }
    });
    server.once('error', reject);
  });
}

function open(roomId, clientId, mode) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(
      `${baseUrl}?roomId=${encodeURIComponent(roomId)}&clientId=${clientId}&name=${clientId}&mode=${mode}`
    );
    const inbox = { messages: [], waiters: [] };
    inboxes.set(socket, inbox);
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      const waiter = inbox.waiters.shift();
      if (waiter) waiter(message);
      else inbox.messages.push(message);
    });
    socket.addEventListener('open', () => resolve(socket), { once: true });
    socket.addEventListener('error', () => reject(new Error(`could not connect ${clientId}`)), { once: true });
  });
}

function next(socket, timeout = 2000) {
  return new Promise((resolve, reject) => {
    const inbox = inboxes.get(socket);
    const buffered = inbox.messages.shift();
    if (buffered) {
      resolve(buffered);
      return;
    }
    const timer = setTimeout(() => reject(new Error('timed out waiting for message')), timeout);
    inbox.waiters.push((message) => {
      clearTimeout(timer);
      resolve(message);
    });
  });
}

async function until(socket, predicate) {
  for (;;) {
    const message = await next(socket);
    if (predicate(message)) return message;
  }
}

try {
  await waitForServer();

  const missing = await open('does-not-exist', 'missing', 'join');
  assert.equal((await next(missing)).type, 'error');
  missing.close();

  const clients = [];
  const first = await open('five-client-room', 'client-1', 'create');
  clients.push(first);
  assert.equal((await next(first)).type, 'welcome');

  const duplicate = await open('five-client-room', 'duplicate', 'create');
  const duplicateError = await next(duplicate);
  assert.equal(duplicateError.type, 'error');
  assert.match(duplicateError.message, /already exists/i);
  duplicate.close();

  for (let i = 2; i <= 5; i += 1) {
    const client = await open('five-client-room', `client-${i}`, 'join');
    clients.push(client);
    const welcome = await next(client);
    assert.equal(welcome.type, 'welcome');
    assert.equal(welcome.participants.length, i);
    await until(first, (message) => message.type === 'presence' && message.participants.length === i);
  }

  first.send(JSON.stringify({ type: 'cursor', x: 120, y: 80, seq: 1, t: 1 }));
  for (const client of clients.slice(1)) {
    const cursor = await until(client, (message) => message.type === 'cursor');
    assert.deepEqual(cursor, { type: 'cursor', clientId: 'client-1', x: 120, y: 80, seq: 1, t: 1 });
  }

  clients[1].send(JSON.stringify({ type: 'reaction', emoji: '🎉', x: 40, y: 50, seq: 1, t: 2 }));
  for (const client of [first, ...clients.slice(2)]) {
    const reaction = await until(client, (message) => message.type === 'reaction');
    assert.equal(reaction.clientId, 'client-2');
    assert.equal(reaction.emoji, '🎉');
  }

  const leave = until(first, (message) => message.type === 'leave' && message.clientId === 'client-5');
  clients[4].close();
  await leave;
  for (const client of clients.slice(0, 4)) client.close();

  console.log('PASS: room create/join rules, five-client presence, cursor relay, reaction relay, and leave cleanup');
} finally {
  server.kill();
}
