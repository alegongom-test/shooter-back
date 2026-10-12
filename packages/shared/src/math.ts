export interface Vec2 {
  x: number;
  y: number;
}

export const TAU = Math.PI * 2;

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function wrapAngle(a: number): number {
  a %= TAU;
  return a < 0 ? a + TAU : a;
}

/** Interpola por el camino más corto. */
export function lerpAngle(a: number, b: number, t: number): number {
  let d = wrapAngle(b - a);
  if (d > Math.PI) d -= TAU;
  return a + d * t;
}

export function angleToByte(a: number): number {
  return Math.round((wrapAngle(a) / TAU) * 256) & 255;
}

export function byteToAngle(b: number): number {
  return (b / 256) * TAU;
}

export function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
