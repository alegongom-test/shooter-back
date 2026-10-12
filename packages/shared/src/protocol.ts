import { POS_SCALE } from './constants';
import { angleToByte, byteToAngle } from './math';
import type { CombatSetup, ProfileView, RewardView } from './progression';

// ───────────── Mensajes de control (JSON de texto) ─────────────

/** Entrada del jugador para un tick. Se envía 20 veces por segundo. */
export interface InputCmd {
  /** Número de secuencia: el servidor devuelve el último procesado (ack) para la reconciliación. */
  s: number;
  /** Movimiento, componentes en [-1, 1]. */
  mx: number;
  my: number;
  /** Ángulo de apuntado en radianes. */
  a: number;
  /** Disparando. */
  f: boolean;
  /** Ranura de arma seleccionada (índice en el loadout). */
  w: number;
  /** Petición de recarga. */
  r: boolean;
  /** Lanzar granada (petición de un solo tick). */
  g: boolean;
  /** Distancia del lanzamiento como fracción del alcance (0..1). */
  gd: number;
  /** Activar habilidad de clase (petición de un solo tick). */
  ab: boolean;
}

export type ClientMsg =
  | { t: 'register'; user: string; pass: string }
  | { t: 'login'; user: string; pass: string }
  | { t: 'resume'; token: string }
  | { t: 'logout' }
  | { t: 'equip'; slot: number; item: number }
  | { t: 'upgrade'; item: number }
  | { t: 'sell'; item: number }
  | { t: 'setClass'; cls: string }
  | { t: 'skill'; cls: string; skill: string }
  | { t: 'resetSkills'; cls: string }
  | { t: 'create' }
  | { t: 'leave' }
  | { t: 'join'; code: string }
  | { t: 'start' }
  | ({ t: 'i' } & InputCmd)
  | { t: 'ping'; c: number };

export interface LobbyPlayer {
  id: number;
  name: string;
  color: number;
  classId: string;
  level: number;
}

export type RoomPhase = 'lobby' | 'playing' | 'ended';

export interface EndStats {
  result: 'victory' | 'defeat';
  elapsed: number;
  kills: number;
  players: { id: number; name: string; kills: number; deaths: number; revives: number }[];
}

export type ServerMsg =
  | { t: 'auth'; token: string; profile: ProfileView }
  | { t: 'profile'; profile: ProfileView }
  | { t: 'loggedOut' }
  | { t: 'rewards'; rewards: RewardView }
  | { t: 'welcome'; you: number; code: string; mode: string }
  | { t: 'lobby'; host: number; players: LobbyPlayer[]; phase: RoomPhase }
  /** setup = equipo efectivo de quien recibe el mensaje (calculado por el servidor). */
  | { t: 'start'; mode: string; setup: CombatSetup }
  | { t: 'end'; stats: EndStats }
  | { t: 'pong'; c: number }
  /** ctx 'auth' = error de inicio de sesión (el cliente lo muestra en esa pantalla). */
  | { t: 'err'; msg: string; ctx?: 'auth' };

// ───────────── Snapshot del estado (binario) ─────────────

export const MSG_SNAPSHOT = 1;

export const PHASE = { playing: 1, boss: 2, victory: 3, defeat: 4 } as const;
export type PhaseCode = (typeof PHASE)[keyof typeof PHASE];

export const ZFLAG_ATTACK = 1;
export const ZFLAG_WINDUP = 2;
export const ZFLAG_CHARGE = 4;

export const PROJ_GRENADE = 0;
export const PROJ_ACID = 1;

export const FX_GRENADE = 0;
export const FX_FIRE = 1;
export const FX_HEAL = 2;
export const FX_ACID = 3;

export interface SnapPlayer {
  id: number;
  /** Índice de clase en CLASSES. */
  cls: number;
  x: number;
  y: number;
  aim: number;
  /** Vida 0-255 (fracción de la máxima). */
  hp: number;
  alive: boolean;
  /** En el suelo esperando que lo revivan. */
  downed: boolean;
  reloading: boolean;
  abilityActive: boolean;
  weapon: number;
  ammo: number;
  kills: number;
  /** Segundos que faltan para reaparecer (0 si está vivo). */
  respawn: number;
  /** Progreso de reanimación 0-255. */
  revive: number;
  /** Segundos que le quedan en el suelo antes de morir. */
  bleed: number;
  grenades: number;
  /** Segundos de recarga de la habilidad (0 = lista). */
  abilityCd: number;
}

export interface SnapZombie {
  id: number;
  type: number;
  x: number;
  y: number;
  angle: number;
  /** Vida 0-255 (fracción de la máxima). */
  hp: number;
  flags: number;
}

export interface SnapShot {
  pid: number;
  ox: number;
  oy: number;
  ex: number;
  ey: number;
  hit: boolean;
}

export interface SnapBox {
  id: number;
  /** Índice en LOOT.boxes. */
  tier: number;
  x: number;
  y: number;
}

export interface SnapProjectile {
  id: number;
  kind: number;
  x: number;
  y: number;
}

/** Efecto puntual (explosión, curación…) ocurrido en este tick. */
export interface SnapFx {
  kind: number;
  x: number;
  y: number;
  radius: number;
}

export interface Snapshot {
  tick: number;
  /** Último InputCmd.s procesado para el jugador que recibe el mensaje. */
  ack: number;
  phase: PhaseCode;
  elapsedMs: number;
  kills: number;
  /** Cajas recogidas por el equipo en esta partida, por tier. */
  collected: number[];
  players: SnapPlayer[];
  zombies: SnapZombie[];
  shots: SnapShot[];
  boxes: SnapBox[];
  projectiles: SnapProjectile[];
  fx: SnapFx[];
}

const HEADER = 1 + 4 + 4 + 1 + 4 + 2;
const PLAYER_BYTES = 1 + 1 + 2 + 2 + 1 + 1 + 1 + 1 + 1 + 2 + 1 + 1 + 1 + 1 + 1;
const ZOMBIE_BYTES = 2 + 1 + 2 + 2 + 1 + 1 + 1;
const SHOT_BYTES = 1 + 2 * 4 + 1;
const BOX_BYTES = 2 + 1 + 2 + 2;
const PROJ_BYTES = 2 + 1 + 2 + 2;
const FX_BYTES = 1 + 2 + 2 + 1;
/** Posición del ack dentro del buffer: el servidor codifica una vez y parchea el ack por cliente. */
export const ACK_OFFSET = 5;

const qpos = (v: number) => Math.max(0, Math.min(65535, Math.round(v * POS_SCALE)));
const u8 = (v: number) => Math.max(0, Math.min(255, Math.ceil(v)));
const cap255 = <T>(list: T[]) => (list.length > 255 ? list.slice(0, 255) : list);

export function encodeSnapshot(s: Snapshot): Uint8Array {
  const shots = cap255(s.shots);
  const boxes = cap255(s.boxes);
  const projectiles = cap255(s.projectiles);
  const fx = cap255(s.fx);
  const size =
    HEADER + 1 + s.collected.length +
    1 + s.players.length * PLAYER_BYTES +
    2 + s.zombies.length * ZOMBIE_BYTES +
    1 + shots.length * SHOT_BYTES +
    1 + boxes.length * BOX_BYTES +
    1 + projectiles.length * PROJ_BYTES +
    1 + fx.length * FX_BYTES;
  const buf = new Uint8Array(size);
  const v = new DataView(buf.buffer);
  let o = 0;
  v.setUint8(o, MSG_SNAPSHOT); o += 1;
  v.setUint32(o, s.tick, true); o += 4;
  v.setUint32(o, s.ack >>> 0, true); o += 4;
  v.setUint8(o, s.phase); o += 1;
  v.setUint32(o, Math.round(s.elapsedMs), true); o += 4;
  v.setUint16(o, Math.min(65535, s.kills), true); o += 2;
  v.setUint8(o, s.collected.length); o += 1;
  for (const c of s.collected) { v.setUint8(o, u8(c)); o += 1; }

  v.setUint8(o, s.players.length); o += 1;
  for (const p of s.players) {
    v.setUint8(o, p.id); o += 1;
    v.setUint8(o, p.cls); o += 1;
    v.setUint16(o, qpos(p.x), true); o += 2;
    v.setUint16(o, qpos(p.y), true); o += 2;
    v.setUint8(o, angleToByte(p.aim)); o += 1;
    v.setUint8(o, p.hp); o += 1;
    v.setUint8(o, (p.alive ? 1 : 0) | (p.reloading ? 2 : 0) | (p.downed ? 4 : 0) | (p.abilityActive ? 8 : 0)); o += 1;
    v.setUint8(o, p.weapon); o += 1;
    v.setUint8(o, u8(p.ammo)); o += 1;
    v.setUint16(o, Math.min(65535, p.kills), true); o += 2;
    v.setUint8(o, u8(p.respawn)); o += 1;
    v.setUint8(o, u8(p.revive)); o += 1;
    v.setUint8(o, u8(p.bleed)); o += 1;
    v.setUint8(o, u8(p.grenades)); o += 1;
    v.setUint8(o, u8(p.abilityCd)); o += 1;
  }

  v.setUint16(o, s.zombies.length, true); o += 2;
  for (const z of s.zombies) {
    v.setUint16(o, z.id, true); o += 2;
    v.setUint8(o, z.type); o += 1;
    v.setUint16(o, qpos(z.x), true); o += 2;
    v.setUint16(o, qpos(z.y), true); o += 2;
    v.setUint8(o, angleToByte(z.angle)); o += 1;
    v.setUint8(o, z.hp); o += 1;
    v.setUint8(o, z.flags); o += 1;
  }

  v.setUint8(o, shots.length); o += 1;
  for (const sh of shots) {
    v.setUint8(o, sh.pid); o += 1;
    v.setUint16(o, qpos(sh.ox), true); o += 2;
    v.setUint16(o, qpos(sh.oy), true); o += 2;
    v.setUint16(o, qpos(sh.ex), true); o += 2;
    v.setUint16(o, qpos(sh.ey), true); o += 2;
    v.setUint8(o, sh.hit ? 1 : 0); o += 1;
  }

  v.setUint8(o, boxes.length); o += 1;
  for (const b of boxes) {
    v.setUint16(o, b.id, true); o += 2;
    v.setUint8(o, b.tier); o += 1;
    v.setUint16(o, qpos(b.x), true); o += 2;
    v.setUint16(o, qpos(b.y), true); o += 2;
  }

  v.setUint8(o, projectiles.length); o += 1;
  for (const p of projectiles) {
    v.setUint16(o, p.id, true); o += 2;
    v.setUint8(o, p.kind); o += 1;
    v.setUint16(o, qpos(p.x), true); o += 2;
    v.setUint16(o, qpos(p.y), true); o += 2;
  }

  v.setUint8(o, fx.length); o += 1;
  for (const f of fx) {
    v.setUint8(o, f.kind); o += 1;
    v.setUint16(o, qpos(f.x), true); o += 2;
    v.setUint16(o, qpos(f.y), true); o += 2;
    v.setUint8(o, u8(f.radius / 2)); o += 1;
  }
  return buf;
}

export function patchAck(buf: Uint8Array, ack: number): void {
  new DataView(buf.buffer, buf.byteOffset, buf.byteLength).setUint32(ACK_OFFSET, ack >>> 0, true);
}

export function decodeSnapshot(data: ArrayBuffer | Uint8Array): Snapshot {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 1;
  const r8 = () => v.getUint8(o++);
  const r16 = () => { const x = v.getUint16(o, true); o += 2; return x; };
  const r32 = () => { const x = v.getUint32(o, true); o += 4; return x; };
  const rpos = () => r16() / POS_SCALE;

  const tick = r32();
  const ack = r32();
  const phase = r8() as PhaseCode;
  const elapsedMs = r32();
  const kills = r16();
  const collected: number[] = [];
  for (let i = 0, n = r8(); i < n; i++) collected.push(r8());

  const players: SnapPlayer[] = [];
  for (let i = 0, n = r8(); i < n; i++) {
    const id = r8();
    const cls = r8();
    const x = rpos();
    const y = rpos();
    const aim = byteToAngle(r8());
    const hp = r8();
    const fl = r8();
    const weapon = r8();
    const ammo = r8();
    const pk = r16();
    const respawn = r8();
    const revive = r8();
    const bleed = r8();
    const grenades = r8();
    const abilityCd = r8();
    players.push({
      id, cls, x, y, aim, hp,
      alive: (fl & 1) !== 0, reloading: (fl & 2) !== 0, downed: (fl & 4) !== 0, abilityActive: (fl & 8) !== 0,
      weapon, ammo, kills: pk, respawn, revive, bleed, grenades, abilityCd,
    });
  }

  const zombies: SnapZombie[] = [];
  for (let i = 0, n = r16(); i < n; i++) {
    const id = r16();
    const type = r8();
    const x = rpos();
    const y = rpos();
    const angle = byteToAngle(r8());
    const hp = r8();
    const flags = r8();
    zombies.push({ id, type, x, y, angle, hp, flags });
  }

  const shots: SnapShot[] = [];
  for (let i = 0, n = r8(); i < n; i++) {
    const pid = r8();
    const ox = rpos();
    const oy = rpos();
    const ex = rpos();
    const ey = rpos();
    const hit = r8() === 1;
    shots.push({ pid, ox, oy, ex, ey, hit });
  }

  const boxes: SnapBox[] = [];
  for (let i = 0, n = r8(); i < n; i++) {
    const id = r16();
    const tier = r8();
    boxes.push({ id, tier, x: rpos(), y: rpos() });
  }

  const projectiles: SnapProjectile[] = [];
  for (let i = 0, n = r8(); i < n; i++) {
    const id = r16();
    const kind = r8();
    projectiles.push({ id, kind, x: rpos(), y: rpos() });
  }

  const fx: SnapFx[] = [];
  for (let i = 0, n = r8(); i < n; i++) {
    const kind = r8();
    const x = rpos();
    const y = rpos();
    fx.push({ kind, x, y, radius: r8() * 2 });
  }

  return { tick, ack, phase, elapsedMs, kills, collected, players, zombies, shots, boxes, projectiles, fx };
}
