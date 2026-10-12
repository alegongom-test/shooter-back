import type { GameMap, Vec2 } from '@horda/shared';

const STRAIGHT = 10;
const DIAGONAL = 14;
const NEIGHBORS: [number, number, number][] = [
  [1, 0, STRAIGHT], [-1, 0, STRAIGHT], [0, 1, STRAIGHT], [0, -1, STRAIGHT],
  [1, 1, DIAGONAL], [1, -1, DIAGONAL], [-1, 1, DIAGONAL], [-1, -1, DIAGONAL],
];

/**
 * Campo de flujo hacia los jugadores: un Dijkstra multi-origen sobre la rejilla, calculado unas
 * pocas veces por segundo. Cada zombi solo consulta su casilla, así cientos de zombis cuestan casi nada.
 */
export class FlowField {
  private readonly dist: Int32Array;
  private readonly next: Int32Array;
  private readonly heap: number[] = [];

  constructor(private readonly map: GameMap) {
    const n = map.width * map.height;
    this.dist = new Int32Array(n);
    this.next = new Int32Array(n).fill(-1);
  }

  update(targets: Vec2[]): void {
    const { map, dist, next } = this;
    const w = map.width;
    dist.fill(0x7fffffff);
    next.fill(-1);
    this.heap.length = 0;
    for (const t of targets) {
      const tx = Math.floor(t.x / map.tileSize);
      const ty = Math.floor(t.y / map.tileSize);
      if (map.isSolid(tx, ty)) continue;
      const i = ty * w + tx;
      dist[i] = 0;
      this.push(i);
    }
    while (this.heap.length) {
      const i = this.pop();
      const cx = i % w;
      const cy = (i - cx) / w;
      const d = dist[i];
      for (const [dx, dy, cost] of NEIGHBORS) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (map.isSolid(nx, ny)) continue;
        // Sin cortar esquinas en diagonal.
        if (dx !== 0 && dy !== 0 && (map.isSolid(cx + dx, cy) || map.isSolid(cx, cy + dy))) continue;
        const ni = ny * w + nx;
        const nd = d + cost;
        if (nd < dist[ni]) {
          dist[ni] = nd;
          next[ni] = i;
          this.push(ni);
        }
      }
    }
  }

  /** Centro de la siguiente casilla hacia el jugador más cercano, o null si no hay camino. */
  nextStep(x: number, y: number): Vec2 | null {
    const { map } = this;
    const tx = Math.floor(x / map.tileSize);
    const ty = Math.floor(y / map.tileSize);
    if (tx < 0 || ty < 0 || tx >= map.width || ty >= map.height) return null;
    const ni = this.next[ty * map.width + tx];
    if (ni < 0) return null;
    const nx = ni % map.width;
    const ny = (ni - nx) / map.width;
    return { x: (nx + 0.5) * map.tileSize, y: (ny + 0.5) * map.tileSize };
  }

  // Montículo binario mínimo de índices ordenados por dist.
  private push(i: number): void {
    const h = this.heap;
    const d = this.dist;
    h.push(i);
    let c = h.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (d[h[p]] <= d[h[c]]) break;
      [h[p], h[c]] = [h[c], h[p]];
      c = p;
    }
  }

  private pop(): number {
    const h = this.heap;
    const d = this.dist;
    const top = h[0];
    const last = h.pop()!;
    if (h.length) {
      h[0] = last;
      let p = 0;
      for (;;) {
        const l = p * 2 + 1;
        const r = l + 1;
        let m = p;
        if (l < h.length && d[h[l]] < d[h[m]]) m = l;
        if (r < h.length && d[h[r]] < d[h[m]]) m = r;
        if (m === p) break;
        [h[p], h[m]] = [h[m], h[p]];
        p = m;
      }
    }
    return top;
  }
}
