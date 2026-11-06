/**
 * Where an arrow key moves in a one-stop group: Up and Left go back, Down
 * and Right go on, wrapping at the ends; Home and End go to either end.
 * Null for any other key.
 */
export function rovingTarget<T>(items: readonly T[], current: number, key: string): T | null {
  if (!items.length) return null;
  const step: Record<string, number> = { ArrowUp: -1, ArrowLeft: -1, ArrowDown: 1, ArrowRight: 1 };
  if (key === "Home") return items[0] ?? null;
  if (key === "End") return items[items.length - 1] ?? null;
  const delta = step[key];
  if (delta === undefined) return null;
  return items[(current + delta + items.length) % items.length] ?? null;
}
