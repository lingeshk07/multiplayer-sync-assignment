export interface RemoteCursorView {
  x: number;
  y: number;
  color: string;
  name: string;
}

export interface ReactionBurst {
  x: number;
  y: number;
  emoji: string;
  startedAt: number; // performance.now() when spawned
}

const REACTION_LIFETIME_MS = 900;

export function drawFrame(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  cursors: Map<string, RemoteCursorView>,
  reactions: ReactionBurst[],
  now: number
) {
  ctx.clearRect(0, 0, width, height);

  for (const cursor of cursors.values()) {
    drawCursor(ctx, { ...cursor, x: cursor.x * width, y: cursor.y * height });
  }

  for (const r of reactions) {
    const age = now - r.startedAt;
    if (age > REACTION_LIFETIME_MS) continue;
    const progress = age / REACTION_LIFETIME_MS;
    ctx.save();
    ctx.globalAlpha = 1 - progress;
    ctx.font = `${28 + progress * 16}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(r.emoji, r.x * width, r.y * height - progress * 40);
    ctx.restore();
  }
}

function drawCursor(ctx: CanvasRenderingContext2D, c: RemoteCursorView) {
  ctx.save();
  ctx.fillStyle = c.color;
  ctx.beginPath();
  ctx.moveTo(c.x, c.y);
  ctx.lineTo(c.x + 12, c.y + 4);
  ctx.lineTo(c.x + 4, c.y + 12);
  ctx.closePath();
  ctx.fill();

  ctx.font = '12px sans-serif';
  ctx.fillStyle = '#111';
  ctx.fillText(c.name, c.x + 14, c.y + 20);
  ctx.restore();
}

export function pruneReactions(reactions: ReactionBurst[], now: number): ReactionBurst[] {
  return reactions.filter((r) => now - r.startedAt <= REACTION_LIFETIME_MS);
}
