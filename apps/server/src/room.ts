import {
  MAX_PLAYERS,
  TICK_MS,
  clamp,
  encodeSnapshot,
  getMode,
  patchAck,
  round3,
  type ClientMsg,
  type InputCmd,
  type LobbyPlayer,
  type ModeDef,
  type RoomPhase,
  type ServerMsg,
} from '@horda/shared';
import type { WebSocket } from 'ws';
import { accounts } from './accounts';
import { Simulation } from './simulation';

export interface Client {
  ws: WebSocket;
  room: Room | null;
  playerId: number;
  /** 0 = sin iniciar sesión. */
  userId: number;
  username: string;
  token: string;
}

interface Member extends LobbyPlayer {
  client: Client;
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const rooms = new Map<string, Room>();

export function createRoom(modeId: string): Room {
  let code = '';
  do {
    code = Array.from({ length: 4 }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join('');
  } while (rooms.has(code));
  const room = new Room(code, modeId);
  rooms.set(code, room);
  return room;
}

export function findRoom(code: string): Room | undefined {
  return rooms.get(code.trim().toUpperCase());
}

export function roomCount(): number {
  return rooms.size;
}

/** Una sala = una partida de 1 a 4 jugadores. Escalar = tener más salas. */
export class Room {
  phase: RoomPhase = 'lobby';
  private readonly members = new Map<number, Member>();
  private hostId = 0;
  private nextId = 1;
  private sim: Simulation | null = null;
  private loop: NodeJS.Timeout | null = null;
  private nextTickAt = 0;

  constructor(readonly code: string, readonly modeId: string) {}

  get size(): number {
    return this.members.size;
  }

  join(client: Client): void {
    if (this.members.size >= MAX_PLAYERS) {
      send(client, { t: 'err', msg: 'La sala está llena' });
      return;
    }
    if ([...this.members.values()].some((m) => m.client.userId === client.userId)) {
      send(client, { t: 'err', msg: 'Ya estás en esta sala desde otro dispositivo' });
      return;
    }
    const id = this.nextId++;
    const used = new Set([...this.members.values()].map((m) => m.color));
    const color = [0, 1, 2, 3].find((c) => !used.has(c)) ?? 0;
    const name = client.username;
    this.members.set(id, { id, name, color, client, classId: accounts.classId(client.userId), level: accounts.level(client.userId) });
    client.room = this;
    client.playerId = id;
    if (!this.hostId) this.hostId = id;
    send(client, { t: 'welcome', you: id, code: this.code, mode: this.modeId });
    if (this.phase === 'playing' && this.sim) {
      const setup = accounts.combatSetup(client.userId);
      this.sim.addPlayer(id, name, setup);
      send(client, { t: 'start', mode: this.modeId, setup });
    }
    this.broadcastLobby();
    log(`[${this.code}] entra ${name} (#${id}) · ${this.members.size} jugador(es)`);
  }

  leave(client: Client): void {
    const id = client.playerId;
    const m = this.members.get(id);
    if (!m) return;
    this.members.delete(id);
    this.sim?.removePlayer(id);
    client.room = null;
    log(`[${this.code}] sale ${m.name} (#${id})`);
    if (this.members.size === 0) {
      this.stopLoop();
      rooms.delete(this.code);
      log(`[${this.code}] sala cerrada`);
      return;
    }
    if (this.hostId === id) this.hostId = [...this.members.keys()][0];
    this.broadcastLobby();
  }

  /** Actualiza clase y nivel de un miembro en la sala (p. ej. tras cambiar de clase). */
  refresh(client: Client): void {
    const m = this.members.get(client.playerId);
    if (!m) return;
    m.classId = accounts.classId(client.userId);
    m.level = accounts.level(client.userId);
    this.broadcastLobby();
  }

  handle(client: Client, msg: ClientMsg): void {
    switch (msg.t) {
      case 'start':
        if (client.playerId === this.hostId && this.phase !== 'playing') this.start();
        break;
      case 'i':
        if (this.sim) this.sim.pushInput(client.playerId, sanitizeInput(msg));
        break;
      default:
        break;
    }
  }

  private start(): void {
    const mode: ModeDef = { ...getMode(this.modeId) };
    const override = Number(process.env.HORDA_SURVIVE_SECONDS);
    if (override > 0) mode.surviveSeconds = override;
    this.sim = new Simulation(mode);
    this.phase = 'playing';
    for (const m of this.members.values()) {
      const setup = accounts.combatSetup(m.client.userId);
      this.sim.addPlayer(m.id, m.name, setup);
      send(m.client, { t: 'start', mode: this.modeId, setup });
    }
    this.broadcastLobby();
    log(`[${this.code}] partida iniciada (${this.members.size} jugadores, jefe a los ${mode.surviveSeconds}s)`);

    // Bucle de ticks con recuperación: setInterval en Windows tiene ~15 ms de resolución.
    this.nextTickAt = performance.now();
    this.loop = setInterval(() => {
      let steps = 0;
      while (performance.now() >= this.nextTickAt && steps < 4) {
        this.tick();
        this.nextTickAt += TICK_MS;
        steps++;
        if (!this.loop) return;
      }
      if (performance.now() - this.nextTickAt > TICK_MS * 10) this.nextTickAt = performance.now();
    }, 4);
  }

  private tick(): void {
    const sim = this.sim;
    if (!sim) return;
    sim.step();
    const buf = encodeSnapshot(sim.snapshot());
    for (const m of this.members.values()) {
      const copy = buf.slice();
      patchAck(copy, sim.ackFor(m.id));
      if (m.client.ws.readyState === m.client.ws.OPEN) m.client.ws.send(copy);
    }
    if (sim.result) {
      this.stopLoop();
      this.phase = 'ended';
      this.broadcast({ t: 'end', stats: sim.result });
      this.grantRewards(sim);
      this.broadcastLobby();
      log(`[${this.code}] fin: ${sim.result.result} · ${sim.result.kills} bajas · ${sim.result.elapsed}s · cajas [${sim.collected.join(', ')}]`);
      this.sim = null;
    }
  }

  /** Solo reciben recompensa los jugadores que siguen en la sala al terminar. */
  private grantRewards(sim: Simulation): void {
    const result = sim.result!;
    const perf = new Map(sim.playerResults().map((r) => [r.id, r]));
    for (const m of this.members.values()) {
      const p = perf.get(m.id);
      if (!p) continue;
      try {
        const rewards = accounts.grantRewards(m.client.userId, result.result, result.elapsed, p, sim.collected);
        send(m.client, { t: 'rewards', rewards });
        send(m.client, { t: 'profile', profile: accounts.profile(m.client.userId) });
        m.level = accounts.level(m.client.userId);
      } catch (e) {
        log(`[${this.code}] error al dar recompensas a ${m.name}: ${(e as Error).message}`);
      }
    }
  }

  private stopLoop(): void {
    if (this.loop) clearInterval(this.loop);
    this.loop = null;
  }

  private broadcastLobby(): void {
    const players = [...this.members.values()].map(({ id, name, color, classId, level }) => ({ id, name, color, classId, level }));
    this.broadcast({ t: 'lobby', host: this.hostId, players, phase: this.phase });
  }

  private broadcast(msg: ServerMsg): void {
    for (const m of this.members.values()) send(m.client, msg);
  }
}

export function send(client: Client, msg: ServerMsg): void {
  if (client.ws.readyState === client.ws.OPEN) client.ws.send(JSON.stringify(msg));
}

function sanitizeInput(m: InputCmd): InputCmd {
  const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  return {
    s: Math.floor(num(m.s)),
    mx: round3(clamp(num(m.mx), -1, 1)),
    my: round3(clamp(num(m.my), -1, 1)),
    a: num(m.a),
    f: m.f === true,
    w: Math.floor(num(m.w)),
    r: m.r === true,
    g: m.g === true,
    gd: round3(clamp(num(m.gd, 1), 0, 1)),
    ab: m.ab === true,
  };
}

export function log(msg: string): void {
  console.log(`${new Date().toLocaleTimeString()} ${msg}`);
}
