/**
 * Minimal RFC 6455 WebSocket server transport, built only on Node's
 * built-in `http`, `net`, and `crypto` modules — no `ws` package or any
 * other WebSocket library. This is intentionally scoped to what this
 * assignment needs:
 *
 *   - text frames (opcode 0x1) for JSON messages
 *   - ping/pong (0x9/0xA) for heartbeats
 *   - close (0x8) for clean shutdown
 *
 * Known limitation: fragmented messages (continuation frames, opcode 0x0)
 * are not reassembled. This is safe here because every message we send is
 * a small JSON object, well under the size a browser would ever split
 * across frames automatically.
 */

import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { createHash } from 'crypto';

const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// HTTP upgrade sockets are TCP sockets in production. `Duplex` does not
// expose this TCP-specific method, so retain the generic transport type while
// enabling the capability when it is available.
type TcpCapableDuplex = Duplex & {
  setNoDelay?: (noDelay?: boolean) => void;
};

export type OpCode = 0x0 | 0x1 | 0x2 | 0x8 | 0x9 | 0xa;

interface FrameHandlers {
  onText: (msg: string) => void;
  onClose: (code: number, reason: string) => void;
  onPong: () => void;
}

export class RawSocket {
  private buffer: Buffer = Buffer.alloc(0);
  private handlers: Partial<FrameHandlers> = {};
  private closed = false;

  constructor(private socket: Duplex) {
    socket.on('data', (chunk: Buffer) => this.handleData(chunk));
    socket.on('close', () => this.emitClose(1006, 'tcp socket closed'));
    socket.on('error', () => this.emitClose(1006, 'tcp socket error'));
  }

  onText(cb: (msg: string) => void) {
    this.handlers.onText = cb;
  }
  onClose(cb: (code: number, reason: string) => void) {
    this.handlers.onClose = cb;
  }
  onPong(cb: () => void) {
    this.handlers.onPong = cb;
  }

  send(data: string) {
    if (this.closed) return;
    const payload = Buffer.from(data, 'utf8');
    this.socket.write(this.encodeFrame(payload, 0x1));
  }

  ping() {
    if (this.closed) return;
    this.socket.write(this.encodeFrame(Buffer.alloc(0), 0x9));
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    const reasonBuf = Buffer.from(reason, 'utf8');
    const payload = Buffer.alloc(2 + reasonBuf.length);
    payload.writeUInt16BE(code, 0);
    reasonBuf.copy(payload, 2);
    try {
      this.socket.write(this.encodeFrame(payload, 0x8));
    } catch {
      /* socket may already be gone */
    }
    this.socket.end();
  }

  /**
   * Immediately tears down an unresponsive transport. This intentionally
   * skips the WebSocket close handshake: a heartbeat timeout means that peer
   * cannot be relied upon to receive or acknowledge it.
   */
  terminate() {
    if (this.closed) return;
    this.socket.destroy();
  }

  private emitClose(code: number, reason: string) {
    if (this.closed) return;
    this.closed = true;
    this.handlers.onClose?.(code, reason);
  }

  // Server-to-client frames are sent unmasked, per spec.
  private encodeFrame(payload: Buffer, opcode: OpCode): Buffer {
    const len = payload.length;
    let header: Buffer;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x80 | opcode;
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    return Buffer.concat([header, payload]);
  }

  private handleData(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    // A single TCP chunk may contain multiple frames (or a partial one) —
    // drain everything we can fully parse and leave the remainder buffered.
    for (;;) {
      const frame = this.tryParseFrame(this.buffer);
      if (!frame) break;
      this.buffer = this.buffer.subarray(frame.totalLength);
      this.dispatch(frame.opcode, frame.payload);
    }
  }

  private tryParseFrame(
    buf: Buffer
  ): { opcode: OpCode; payload: Buffer; totalLength: number } | null {
    if (buf.length < 2) return null;

    const first = buf[0];
    const second = buf[1];
    const opcode = (first & 0x0f) as OpCode;
    const masked = (second & 0x80) !== 0;
    let payloadLen = second & 0x7f;
    let offset = 2;

    if (payloadLen === 126) {
      if (buf.length < offset + 2) return null;
      payloadLen = buf.readUInt16BE(offset);
      offset += 2;
    } else if (payloadLen === 127) {
      if (buf.length < offset + 8) return null;
      payloadLen = Number(buf.readBigUInt64BE(offset));
      offset += 8;
    }

    let maskKey: Buffer | null = null;
    if (masked) {
      if (buf.length < offset + 4) return null;
      maskKey = buf.subarray(offset, offset + 4);
      offset += 4;
    }

    if (buf.length < offset + payloadLen) return null; // wait for more data

    let payload = buf.subarray(offset, offset + payloadLen);
    if (masked && maskKey) {
      // All client -> server frames MUST be masked per RFC 6455 §5.3.
      const unmasked = Buffer.alloc(payloadLen);
      for (let i = 0; i < payloadLen; i++) {
        unmasked[i] = payload[i] ^ maskKey[i % 4];
      }
      payload = unmasked;
    }

    return { opcode, payload: Buffer.from(payload), totalLength: offset + payloadLen };
  }

  private dispatch(opcode: OpCode, payload: Buffer) {
    switch (opcode) {
      case 0x1: // text frame
        this.handlers.onText?.(payload.toString('utf8'));
        break;
      case 0x8: { // close frame
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
        try {
          this.socket.write(this.encodeFrame(payload, 0x8)); // echo close per spec
        } catch {
          /* ignore */
        }
        try {
          this.socket.end();
        } catch {
          /* ignore */
        }
        this.emitClose(code, reason);
        break;
      }
      case 0x9: // ping -> reply pong
        try {
          this.socket.write(this.encodeFrame(payload, 0xa));
        } catch {
          /* ignore */
        }
        break;
      case 0xa: // pong
        this.handlers.onPong?.();
        break;
      default:
        // binary (0x2) and continuation (0x0) frames are out of scope.
        break;
    }
  }
}

/**
 * Performs the RFC 6455 opening handshake on a raw HTTP upgrade request and
 * returns a RawSocket wrapping the now-upgraded TCP socket, or null if the
 * request wasn't a valid WebSocket upgrade (in which case a 400 is sent).
 */
export function performHandshake(req: IncomingMessage, socket: Duplex): RawSocket | null {
  const key = req.headers['sec-websocket-key'];
  const upgradeHeader = String(req.headers.upgrade ?? '').toLowerCase();

  if (!key || typeof key !== 'string' || upgradeHeader !== 'websocket') {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return null;
  }

  const accept = createHash('sha1').update(key + WEBSOCKET_GUID).digest('base64');
  const responseHeaders = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '\r\n',
  ].join('\r\n');

  // Cursor, reaction, and ping/pong frames are deliberately small and
  // latency-sensitive. Disable Nagle on this upgraded TCP connection so a
  // small server response is not held while waiting to batch more data.
  (socket as TcpCapableDuplex).setNoDelay?.(true);
  socket.write(responseHeaders);
  return new RawSocket(socket);
}
