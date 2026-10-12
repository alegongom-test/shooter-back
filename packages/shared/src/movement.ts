import type { GameMap } from './map';
import type { Vec2 } from './math';
import type { InputCmd } from './protocol';

/**
 * Movimiento del jugador. Es la misma función en servidor y cliente:
 * así la predicción del cliente coincide con la simulación autoritativa.
 */
export function applyMovement(map: GameMap, pos: Vec2, cmd: InputCmd, speed: number, radius: number, dt: number): void {
  let mx = cmd.mx;
  let my = cmd.my;
  const len = Math.hypot(mx, my);
  if (len > 1) {
    mx /= len;
    my /= len;
  }
  const p = map.moveCircle(pos.x, pos.y, mx * speed * dt, my * speed * dt, radius);
  pos.x = p.x;
  pos.y = p.y;
}
