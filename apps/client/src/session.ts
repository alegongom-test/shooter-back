import {
  GameMap,
  INTERP_DELAY_MS,
  MSG_SNAPSHOT,
  TICK_DT,
  TICK_MS,
  applyMovement,
  WEAPON_SLOTS,
  buildCombatSetup,
  decodeSnapshot,
  getMap,
  getMode,
  lerp,
  lerpAngle,
  moveSpeed,
  type CombatSetup,
  type EndStats,
  type InputCmd,
  type ItemData,
  type LobbyPlayer,
  type ProfileView,
  type RewardView,
  type ModeDef,
  type RoomPhase,
  type ServerMsg,
  type SnapPlayer,
  type SnapShot,
  type SnapZombie,
  type Snapshot,
  type Vec2,
  type WeaponDef,
} from '@horda/shared';
import { save } from './config';
import { Connection } from './net';

type Events = {
  auth: [];
  authError: [string];
  profile: [];
  loggedOut: [];
  rewards: [RewardView];
  welcome: [];
  lobby: [];
  start: [];
  end: [EndStats];
  error: [string];
  disconnect: [];
};

const MAX_SNAPSHOTS = 40;
const MAX_PENDING = 60;
/** Si la predicción se desvía más que esto, se corrige de golpe en vez de suavizar. */
const SNAP_CORRECTION_DIST = 96;

export interface QueuedShot {
  tick: number;
  shot: SnapShot;
}

/** Estado de la conexión y de la partida en curso. Las escenas de Phaser solo leen de aquí. */
export class Session {
  conn: Connection | null = null;
  url = '';
  token = '';
  profile: ProfileView | null = null;
  you = 0;
  code = '';
  host = 0;
  players: LobbyPlayer[] = [];
  roomPhase: RoomPhase = 'lobby';
  ping = 0;

  mode!: ModeDef;
  map!: GameMap;
  /** Equipo efectivo de esta partida: lo calcula el servidor y llega en 'start'. */
  setup!: CombatSetup;
  weapons: WeaponDef[] = [];
  /** Objetos del equipo de esta partida (para mostrar rareza en el HUD). */
  loadoutItems: (ItemData | undefined)[] = [];

  latest: Snapshot | null = null;
  private snaps: Snapshot[] = [];
  private clockOffset: number | null = null;

  /** Predicción de la posición propia (estado actual y anterior, para interpolar a 60 fps). */
  pred: Vec2 = { x: 0, y: 0 };
  prevPred: Vec2 = { x: 0, y: 0 };
  hasPred = false;
  /** Error de reconciliación que se va absorbiendo poco a poco al pintar. */
  predError: Vec2 = { x: 0, y: 0 };
  private pending: InputCmd[] = [];
  private seq = 0;
  private wasAlive = false;

  readonly shotQueue: QueuedShot[] = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private listeners: Partial<Record<keyof Events, ((...a: any[]) => void)[]>> = {};
  private pingTimer: number | undefined;

  on<K extends keyof Events>(ev: K, fn: (...a: Events[K]) => void): void {
    const list = (this.listeners[ev] ??= []) as ((...a: Events[K]) => void)[];
    list.push(fn);
  }

  private emit<K extends keyof Events>(ev: K, ...a: Events[K]): void {
    for (const fn of this.listeners[ev] ?? []) fn(...a);
  }

  get isHost(): boolean {
    return this.you !== 0 && this.you === this.host;
  }

  async connect(url: string, lagMs: number, jitterMs: number): Promise<void> {
    if (this.conn?.open && this.url === url) return;
    this.disconnect();
    const conn = await Connection.open(url, lagMs, jitterMs);
    this.conn = conn;
    this.url = url;
    conn.onJson = (m) => this.handleJson(m);
    conn.onBinary = (b) => this.handleBinary(b);
    conn.onClose = () => {
      this.conn = null;
      this.you = 0;
      clearInterval(this.pingTimer);
      this.emit('disconnect');
    };
    this.pingTimer = window.setInterval(() => conn.send({ t: 'ping', c: performance.now() }), 1000);
  }

  disconnect(): void {
    clearInterval(this.pingTimer);
    this.conn?.close();
    this.conn = null;
    this.you = 0;
  }

  register(user: string, pass: string): void {
    this.conn?.send({ t: 'register', user, pass });
  }

  login(user: string, pass: string): void {
    this.conn?.send({ t: 'login', user, pass });
  }

  resume(token: string): void {
    this.conn?.send({ t: 'resume', token });
  }

  logout(): void {
    this.conn?.send({ t: 'logout' });
    this.token = '';
    this.profile = null;
    save('token', '');
  }

  equip(slot: number, item: number): void {
    this.conn?.send({ t: 'equip', slot, item });
  }

  upgrade(item: number): void {
    this.conn?.send({ t: 'upgrade', item });
  }

  sell(item: number): void {
    this.conn?.send({ t: 'sell', item });
  }

  leaveRoom(): void {
    this.conn?.send({ t: 'leave' });
    this.code = '';
    this.you = 0;
  }

  setClass(cls: string): void {
    this.conn?.send({ t: 'setClass', cls });
  }

  learnSkill(cls: string, skill: string): void {
    this.conn?.send({ t: 'skill', cls, skill });
  }

  resetSkills(cls: string): void {
    this.conn?.send({ t: 'resetSkills', cls });
  }

  createRoom(): void {
    this.conn?.send({ t: 'create' });
  }

  joinRoom(code: string): void {
    this.conn?.send({ t: 'join', code: code.toUpperCase() });
  }

  startGame(): void {
    this.conn?.send({ t: 'start' });
  }

  playerInfo(id: number): LobbyPlayer | undefined {
    return this.players.find((p) => p.id === id);
  }

  me(): SnapPlayer | undefined {
    return this.latest?.players.find((p) => p.id === this.you);
  }

  /** Envía el input de este tick y lo aplica en local (predicción). */
  sendInput(cmd: Omit<InputCmd, 's'>): InputCmd {
    const full: InputCmd = { ...cmd, s: ++this.seq };
    this.conn?.send({ t: 'i', ...full });
    this.pending.push(full);
    if (this.pending.length > MAX_PENDING) this.pending.shift();
    this.prevPred = { ...this.pred };
    const me = this.me();
    if (this.hasPred && me?.alive) applyMovement(this.map, this.pred, full, moveSpeed(this.setup, me.abilityActive), this.setup.radius, TICK_DT);
    return full;
  }

  /** Tick de servidor que se está pintando ahora (con el retraso de interpolación). */
  renderTick(now: number): number {
    if (this.clockOffset === null) return 0;
    return (now - this.clockOffset - INTERP_DELAY_MS) / TICK_MS;
  }

  /** Estado interpolado de los demás jugadores y de los zombis. */
  interpolated(now: number): { players: SnapPlayer[]; zombies: SnapZombie[] } {
    const snaps = this.snaps;
    if (!snaps.length) return { players: [], zombies: [] };
    const rt = this.renderTick(now);
    let a = snaps[0];
    let b = snaps[0];
    let t = 0;
    if (rt >= snaps[snaps.length - 1].tick) {
      a = b = snaps[snaps.length - 1];
    } else if (rt > snaps[0].tick) {
      for (let i = 0; i < snaps.length - 1; i++) {
        if (snaps[i].tick <= rt && rt < snaps[i + 1].tick) {
          a = snaps[i];
          b = snaps[i + 1];
          t = (rt - a.tick) / (b.tick - a.tick);
          break;
        }
      }
    }
    const lerpEntity = <T extends { id: number; x: number; y: number }>(listA: T[], listB: T[], angleKey: keyof T): T[] => {
      if (a === b) return listB;
      const byId = new Map(listA.map((e) => [e.id, e]));
      return listB.map((eb) => {
        const ea = byId.get(eb.id);
        if (!ea) return eb;
        return {
          ...eb,
          x: lerp(ea.x, eb.x, t),
          y: lerp(ea.y, eb.y, t),
          [angleKey]: lerpAngle(ea[angleKey] as number, eb[angleKey] as number, t),
        };
      });
    };
    return {
      players: lerpEntity(a.players, b.players, 'aim'),
      zombies: lerpEntity(a.zombies, b.zombies, 'angle'),
    };
  }

  private handleJson(msg: ServerMsg): void {
    switch (msg.t) {
      case 'auth':
        this.token = msg.token;
        this.profile = msg.profile;
        save('token', msg.token);
        this.emit('auth');
        break;
      case 'profile':
        this.profile = msg.profile;
        this.emit('profile');
        break;
      case 'loggedOut':
        this.emit('loggedOut');
        break;
      case 'rewards':
        this.emit('rewards', msg.rewards);
        break;
      case 'welcome':
        this.you = msg.you;
        this.code = msg.code;
        this.prepare(msg.mode);
        this.emit('welcome');
        break;
      case 'lobby':
        this.host = msg.host;
        this.players = msg.players;
        this.roomPhase = msg.phase;
        this.emit('lobby');
        break;
      case 'start':
        this.prepare(msg.mode, msg.setup);
        this.resetGame();
        this.emit('start');
        break;
      case 'end':
        this.emit('end', msg.stats);
        break;
      case 'pong':
        this.ping = Math.round(performance.now() - msg.c);
        break;
      case 'err':
        if (msg.ctx === 'auth') this.emit('authError', msg.msg);
        else this.emit('error', msg.msg);
        break;
    }
  }

  private prepare(modeId: string, setup?: CombatSetup): void {
    this.mode = getMode(modeId);
    this.map = new GameMap(getMap(this.mode.map));
    const items = this.profile?.items ?? [];
    this.loadoutItems = (this.profile?.loadout ?? []).map((id) => items.find((i) => i.id === id));
    // Sin setup del servidor (no debería pasar), se calcula igual que él a partir del perfil.
    const p = this.profile;
    this.setup = setup ?? buildCombatSetup(p?.classId ?? '', p?.level ?? 1, p?.skills[p.classId], this.loadoutItems);
    this.weapons = this.setup.weapons.slice(0, WEAPON_SLOTS);
  }

  private resetGame(): void {
    this.snaps = [];
    this.latest = null;
    this.clockOffset = null;
    this.pending = [];
    this.hasPred = false;
    this.wasAlive = false;
    this.predError = { x: 0, y: 0 };
    this.shotQueue.length = 0;
  }

  private handleBinary(buf: ArrayBuffer): void {
    if (new Uint8Array(buf)[0] !== MSG_SNAPSHOT) return;
    const snap = decodeSnapshot(buf);
    const last = this.snaps[this.snaps.length - 1];
    if (last && snap.tick <= last.tick) return;
    this.snaps.push(snap);
    if (this.snaps.length > MAX_SNAPSHOTS) this.snaps.shift();
    this.latest = snap;

    // Reloj: el offset más bajo observado (= paquete más rápido), relajándose despacio hacia arriba.
    const sample = performance.now() - snap.tick * TICK_MS;
    if (this.clockOffset === null || sample < this.clockOffset) this.clockOffset = sample;
    else this.clockOffset += (sample - this.clockOffset) * 0.01;

    for (const shot of snap.shots) this.shotQueue.push({ tick: snap.tick, shot });
    if (this.shotQueue.length > 600) this.shotQueue.splice(0, this.shotQueue.length - 600);

    this.reconcile(snap);
  }

  /** Reconciliación: partir de la posición autoritativa y volver a aplicar los inputs aún no confirmados. */
  private reconcile(snap: Snapshot): void {
    const me = snap.players.find((p) => p.id === this.you);
    if (!me) return;
    this.pending = this.pending.filter((c) => c.s > snap.ack);
    if (!me.alive) {
      this.wasAlive = false;
      this.pred = { x: me.x, y: me.y };
      this.prevPred = { ...this.pred };
      this.hasPred = true;
      return;
    }
    const pos = { x: me.x, y: me.y };
    const speed = moveSpeed(this.setup, me.abilityActive);
    for (const c of this.pending) applyMovement(this.map, pos, c, speed, this.setup.radius, TICK_DT);
    if (!this.hasPred || !this.wasAlive) {
      this.pred = pos;
      this.prevPred = { ...pos };
      this.predError = { x: 0, y: 0 };
    } else {
      const ex = this.pred.x - pos.x;
      const ey = this.pred.y - pos.y;
      if (Math.hypot(ex, ey) > SNAP_CORRECTION_DIST) {
        this.predError = { x: 0, y: 0 };
        this.prevPred = { ...pos };
      } else {
        this.predError.x += ex;
        this.predError.y += ey;
        this.prevPred.x -= ex;
        this.prevPred.y -= ey;
      }
      this.pred = pos;
    }
    this.hasPred = true;
    this.wasAlive = true;
  }
}

export const session = new Session();
