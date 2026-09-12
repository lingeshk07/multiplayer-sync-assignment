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
  count: number;
}

const REACTION_LIFETIME_MS = 900;
const REACTION_MERGE_WINDOW_MS = 250;
const REACTION_MERGE_DISTANCE = 0.035;

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
    if (r.count > 1) {
      ctx.font = 'bold 12px sans-serif';
      ctx.fillStyle = '#171c36';
      ctx.fillText(`×${r.count}`, r.x * width + 23, r.y * height - progress * 40 - 12);
    }
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

/**
 * Coalesce near-simultaneous reactions at the same normalized canvas area.
 * Reactions remain discrete server events; this only makes their visual result
 * readable when multiple people tap the same target together.
 */
export function reconcileReaction(
  reactions: ReactionBurst[],
  reaction: Omit<ReactionBurst, 'count'>
): ReactionBurst[] {
  for (let index = reactions.length - 1; index >= 0; index -= 1) {
    const existing = reactions[index];
    const age = reaction.startedAt - existing.startedAt;
    const distance = Math.hypot(reaction.x - existing.x, reaction.y - existing.y);
    if (age >= 0 && age <= REACTION_MERGE_WINDOW_MS && distance <= REACTION_MERGE_DISTANCE) {
      return reactions.map((burst, currentIndex) =>
        currentIndex === index
          ? { ...burst, emoji: reaction.emoji, count: burst.count + 1, startedAt: reaction.startedAt }
          : burst
      );
    }
  }
  return [...reactions, { ...reaction, count: 1 }];
}
