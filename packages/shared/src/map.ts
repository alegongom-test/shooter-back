import type { MapDef } from './data';
import type { Vec2 } from './math';

/** Mapa de casillas con colisión círculo-casilla. Lo usan servidor (simulación) y cliente (predicción y trazadores). */
export class GameMap {
  readonly tileSize: number;
  readonly width: number;
  readonly height: number;
  readonly solid: Uint8Array;
  readonly zombieSpawns: Vec2[] = [];
  readonly playerSpawns: Vec2[] = [];

  constructor(readonly def: MapDef) {
    this.tileSize = def.tileSize;
    this.height = def.rows.length;
    this.width = Math.max(...def.rows.map((r) => r.length));
    this.solid = new Uint8Array(this.width * this.height);
    const half = this.tileSize / 2;
    for (let ty = 0; ty < this.height; ty++) {
      const row = def.rows[ty];
      for (let tx = 0; tx < this.width; tx++) {
        const ch = row[tx] ?? '#';
        const center = { x: tx * this.tileSize + half, y: ty * this.tileSize + half };
        if (ch === '#') this.solid[ty * this.width + tx] = 1;
        else if (ch === 'Z') this.zombieSpawns.push(center);
        else if (ch === 'P') this.playerSpawns.push(center);
      }
    }
  }

  get pixelWidth(): number {
    return this.width * this.tileSize;
  }

  get pixelHeight(): number {
    return this.height * this.tileSize;
  }

  isSolid(tx: number, ty: number): boolean {
    if (tx < 0 || ty < 0 || tx >= this.width || ty >= this.height) return true;
    return this.solid[ty * this.width + tx] === 1;
  }

  isSolidAt(px: number, py: number): boolean {
    return this.isSolid(Math.floor(px / this.tileSize), Math.floor(py / this.tileSize));
  }

  /** Empuja un círculo fuera de los muros que solapa. */
  collideCircle(x: number, y: number, r: number): Vec2 {
    const ts = this.tileSize;
    for (let iter = 0; iter < 3; iter++) {
      let moved = false;
      const minTx = Math.floor((x - r) / ts);
      const maxTx = Math.floor((x + r) / ts);
      const minTy = Math.floor((y - r) / ts);
      const maxTy = Math.floor((y + r) / ts);
      for (let ty = minTy; ty <= maxTy; ty++) {
        for (let tx = minTx; tx <= maxTx; tx++) {
          if (!this.isSolid(tx, ty)) continue;
          const left = tx * ts;
          const top = ty * ts;
          const cx = Math.max(left, Math.min(x, left + ts));
          const cy = Math.max(top, Math.min(y, top + ts));
          const dx = x - cx;
          const dy = y - cy;
          const d2 = dx * dx + dy * dy;
          if (d2 >= r * r) continue;
          if (d2 > 1e-9) {
            const d = Math.sqrt(d2);
            const push = r - d;
            x += (dx / d) * push;
            y += (dy / d) * push;
          } else {
            // El centro está dentro de la casilla: salir por el lado más cercano.
            const dl = x - left;
            const dr = left + ts - x;
            const dt = y - top;
            const db = top + ts - y;
            const m = Math.min(dl, dr, dt, db);
            if (m === dl) x = left - r;
            else if (m === dr) x = left + ts + r;
            else if (m === dt) y = top - r;
            else y = top + ts + r;
          }
          moved = true;
        }
      }
      if (!moved) break;
    }
    return { x, y };
  }

  /** Mueve un círculo en pasos pequeños para no atravesar muros a alta velocidad. */
  moveCircle(x: number, y: number, dx: number, dy: number, r: number): Vec2 {
    const len = Math.hypot(dx, dy);
    if (len === 0) return { x, y };
    const steps = Math.max(1, Math.ceil(len / (r * 0.5)));
    const sx = dx / steps;
    const sy = dy / steps;
    let p: Vec2 = { x, y };
    for (let i = 0; i < steps; i++) p = this.collideCircle(p.x + sx, p.y + sy, r);
    return p;
  }

  /** Distancia hasta el primer muro en esa dirección (o maxDist). */
  raycast(ox: number, oy: number, angle: number, maxDist: number): number {
    const step = this.tileSize / 4;
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    for (let d = step; d <= maxDist; d += step) {
      if (this.isSolidAt(ox + c * d, oy + s * d)) return Math.max(0, d - step);
    }
    return maxDist;
  }

  hasLineOfSight(ax: number, ay: number, bx: number, by: number): boolean {
    const dist = Math.hypot(bx - ax, by - ay);
    return this.raycast(ax, ay, Math.atan2(by - ay, bx - ax), dist) >= dist;
  }
}
