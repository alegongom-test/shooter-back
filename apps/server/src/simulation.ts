import {
  COMBAT,
  ENEMIES,
  FX_ACID,
  FX_FIRE,
  FX_GRENADE,
  FX_HEAL,
  GameMap,
  LOOT,
  PHASE,
  PROJ_ACID,
  PROJ_GRENADE,
  TICK_DT,
  ZFLAG_ATTACK,
  ZFLAG_CHARGE,
  ZFLAG_WINDUP,
  applyMovement,
  boxIndex,
  clamp,
  enemyIndex,
  getMap,
  moveSpeed,
  pickWeighted,
  type CombatSetup,
  type DamageType,
  type EndStats,
  type EnemyDef,
  type InputCmd,
  type ModeDef,
  type PhaseCode,
  type PlayerResult,
  type SnapBox,
  type SnapFx,
  type SnapShot,
  type Snapshot,
  type Vec2,
  type WeaponDef,
} from '@horda/shared';
import { FlowField } from './flowfield';

/** Inputs que se procesan como máximo por jugador y tick (evita acelerar enviando de más). */
const MAX_INPUTS_PER_TICK = 3;
const MAX_QUEUED_INPUTS = 8;
const FLOW_UPDATE_TICKS = 5;
const DIRECT_CHASE_DIST = 120;
const SEPARATION_CELL = 48;
const SAFE_SPAWN_DIST = 380;
const GRENADE_THROW_COOLDOWN = 0.6;
const GRENADE_MIN_DIST = 70;
const ACID_LIFETIME = 2.2;
/** Un Hinchado reventado a tiros hace más daño a los zombis de alrededor que a los jugadores. */
const EXPLODER_ZOMBIE_DAMAGE_MUL = 3;

interface SimPlayer {
  id: number;
  name: string;
  setup: CombatSetup;
  x: number;
  y: number;
  aim: number;
  hp: number;
  /** De pie. */
  alive: boolean;
  /** En el suelo, esperando que lo revivan. */
  downed: boolean;
  bleedTimer: number;
  reviveProgress: number;
  respawnTimer: number;
  weapon: number;
  ammo: number[];
  reloadTimer: number;
  cooldown: number;
  grenades: number;
  grenadeRegen: number;
  grenadeCooldown: number;
  abilityCd: number;
  abilityTimer: number;
  queue: InputCmd[];
  lastSeq: number;
  kills: number;
  deaths: number;
  revives: number;
  xpEarned: number;
  cashEarned: number;
}

type ZState = 'chase' | 'windup' | 'charge';

interface Zombie {
  id: number;
  type: number;
  def: EnemyDef;
  x: number;
  y: number;
  angle: number;
  hp: number;
  maxHp: number;
  speedMul: number;
  attackTimer: number;
  attackFlash: number;
  state: ZState;
  stateTimer: number;
  chargeCooldown: number;
  chargeHit: Set<number>;
  rangedCooldown: number;
  dead: boolean;
}

interface Box extends SnapBox {
  ttl: number;
}

interface Projectile {
  id: number;
  kind: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Granada: distancia que le queda por recorrer. Ácido: vida restante. */
  travel: number;
  fuse: number;
  ownerId: number;
  damage: number;
}

/** Simulación autoritativa de una partida. No sabe nada de red: la sala la avanza y la serializa. */
export class Simulation {
  readonly map: GameMap;
  /** Cajas recogidas por el equipo, por tier (índice en LOOT.boxes). */
  readonly collected: number[] = LOOT.boxes.map(() => 0);
  tick = 0;
  phase: PhaseCode = PHASE.playing;
  elapsed = 0;
  kills = 0;
  result: EndStats | null = null;

  private readonly players = new Map<number, SimPlayer>();
  private zombies: Zombie[] = [];
  private readonly flow: FlowField;
  private readonly shots: SnapShot[] = [];
  private readonly fx: SnapFx[] = [];
  private readonly boxes: Box[] = [];
  private readonly projectiles: Projectile[] = [];
  private nextBoxId = 1;
  private nextZombieId = 1;
  private nextProjectileId = 1;
  private spawnAcc = 0;
  private escortAcc = 0;
  private bossId = 0;

  constructor(readonly mode: ModeDef) {
    this.map = new GameMap(getMap(mode.map));
    this.flow = new FlowField(this.map);
  }

  addPlayer(id: number, name: string, setup: CombatSetup): void {
    const spawn = this.pickPlayerSpawn();
    const p: SimPlayer = {
      id, name, setup, x: spawn.x, y: spawn.y, aim: 0, hp: setup.maxHp,
      alive: true, downed: false, bleedTimer: 0, reviveProgress: 0, respawnTimer: 0,
      weapon: 0, ammo: setup.weapons.map((w) => w.magSize), reloadTimer: 0, cooldown: 0,
      grenades: setup.grenades, grenadeRegen: 0, grenadeCooldown: 0, abilityCd: 0, abilityTimer: 0,
      queue: [], lastSeq: 0, kills: 0, deaths: 0, revives: 0, xpEarned: 0, cashEarned: 0,
    };
    // Si se une a mitad de partida, entra tras la espera de reaparición.
    if (this.elapsed > 0 && this.mode.respawnSeconds > 0) this.killPlayer(p, false);
    this.players.set(id, p);
  }

  removePlayer(id: number): void {
    this.players.delete(id);
  }

  pushInput(id: number, cmd: InputCmd): void {
    const p = this.players.get(id);
    if (!p || cmd.s <= p.lastSeq) return;
    p.queue.push(cmd);
    if (p.queue.length > MAX_QUEUED_INPUTS) p.queue.splice(0, p.queue.length - MAX_QUEUED_INPUTS);
  }

  ackFor(id: number): number {
    return this.players.get(id)?.lastSeq ?? 0;
  }

  step(): void {
    this.tick++;
    this.shots.length = 0;
    this.fx.length = 0;
    if (this.result) return;
    const dt = TICK_DT;

    for (const p of this.players.values()) this.updatePlayerTimers(p, dt);
    for (const p of this.players.values()) this.processInputs(p);
    this.updateDowned(dt);
    this.updateRespawns(dt);
    this.elapsed += dt;
    this.updateSpawning(dt);
    if (this.tick % FLOW_UPDATE_TICKS === 1) this.flow.update(this.standing());
    this.updateZombies(dt);
    this.separate();
    this.updateProjectiles(dt);
    this.zombies = this.zombies.filter((z) => !z.dead);
    this.updateBoxes(dt);
    this.checkEnd();
  }

  snapshot(): Snapshot {
    return {
      tick: this.tick,
      ack: 0,
      phase: this.phase,
      elapsedMs: this.elapsed * 1000,
      kills: this.kills,
      collected: this.collected,
      players: [...this.players.values()].map((p) => ({
        id: p.id, cls: p.setup.classIndex, x: p.x, y: p.y, aim: p.aim,
        hp: Math.ceil((clamp(p.hp, 0, p.setup.maxHp) / p.setup.maxHp) * 255),
        alive: p.alive, downed: p.downed, reloading: p.reloadTimer > 0, abilityActive: p.abilityTimer > 0,
        weapon: p.weapon, ammo: p.ammo[p.weapon], kills: p.kills,
        respawn: p.alive || p.downed ? 0 : Math.max(0, p.respawnTimer),
        revive: Math.floor(p.reviveProgress * 255), bleed: p.downed ? p.bleedTimer : 0,
        grenades: p.grenades, abilityCd: p.abilityCd,
      })),
      zombies: this.zombies.map((z) => ({
        id: z.id, type: z.type, x: z.x, y: z.y, angle: z.angle,
        hp: Math.ceil((Math.max(0, z.hp) / z.maxHp) * 255),
        flags: (z.attackFlash > 0 ? ZFLAG_ATTACK : 0) | (z.state === 'windup' ? ZFLAG_WINDUP : 0) | (z.state === 'charge' ? ZFLAG_CHARGE : 0),
      })),
      shots: this.shots,
      boxes: this.boxes,
      projectiles: this.projectiles.map(({ id, kind, x, y }) => ({ id, kind, x, y })),
      fx: this.fx,
    };
  }

  /** Rendimiento de cada jugador (para calcular recompensas al terminar). */
  playerResults(): PlayerResult[] {
    return [...this.players.values()].map((p) => ({
      id: p.id, kills: p.kills, deaths: p.deaths, revives: p.revives, xpEarned: p.xpEarned, cashEarned: p.cashEarned,
    }));
  }

  private standing(): SimPlayer[] {
    return [...this.players.values()].filter((p) => p.alive);
  }

  // ───────────── Jugadores ─────────────

  private updatePlayerTimers(p: SimPlayer, dt: number): void {
    p.abilityCd = Math.max(0, p.abilityCd - dt);
    p.abilityTimer = Math.max(0, p.abilityTimer - dt);
    p.grenadeCooldown = Math.max(0, p.grenadeCooldown - dt);
    if (p.grenades < p.setup.grenades) {
      p.grenadeRegen += dt;
      if (p.grenadeRegen >= COMBAT.grenade.regenSeconds) {
        p.grenadeRegen = 0;
        p.grenades++;
      }
    } else p.grenadeRegen = 0;
  }

  private processInputs(p: SimPlayer): void {
    const n = Math.min(MAX_INPUTS_PER_TICK, p.queue.length);
    for (let i = 0; i < n; i++) {
      const cmd = p.queue.shift()!;
      p.lastSeq = cmd.s;
      if (!p.alive) continue;
      applyMovement(this.map, p, cmd, moveSpeed(p.setup, p.abilityTimer > 0), p.setup.radius, TICK_DT);
      p.aim = cmd.a;
      this.updateWeapon(p, cmd, TICK_DT);
      if (cmd.g) this.throwGrenade(p, cmd.gd);
      if (cmd.ab) this.useAbility(p);
    }
  }

  private updateWeapon(p: SimPlayer, cmd: InputCmd, dt: number): void {
    const slot = clamp(Math.floor(cmd.w), 0, p.setup.weapons.length - 1);
    if (slot !== p.weapon) {
      p.weapon = slot;
      p.reloadTimer = 0; // cambiar de arma cancela la recarga
    }
    const w = p.setup.weapons[p.weapon];
    p.cooldown = Math.max(0, p.cooldown - dt);
    if (p.reloadTimer > 0) {
      p.reloadTimer -= dt;
      if (p.reloadTimer <= 0) {
        p.reloadTimer = 0;
        p.ammo[p.weapon] = w.magSize;
      }
      return;
    }
    if (cmd.r && p.ammo[p.weapon] < w.magSize) {
      p.reloadTimer = w.reloadTime;
      return;
    }
    if (cmd.f && p.cooldown <= 0) {
      if (p.ammo[p.weapon] <= 0) {
        p.reloadTimer = w.reloadTime;
        return;
      }
      this.fire(p, w);
      p.ammo[p.weapon]--;
      const rateMul = p.abilityTimer > 0 && p.setup.ability.id === 'adrenaline' ? 1 + p.setup.ability.power : 1;
      p.cooldown += 1 / (w.fireRate * rateMul);
      if (p.ammo[p.weapon] <= 0) p.reloadTimer = w.reloadTime;
    }
  }

  private fire(p: SimPlayer, w: WeaponDef): void {
    const ox = p.x + Math.cos(p.aim) * (p.setup.radius + 4);
    const oy = p.y + Math.sin(p.aim) * (p.setup.radius + 4);
    for (let i = 0; i < w.pellets; i++) {
      const base = w.pellets > 1 ? -w.spread / 2 + (w.spread * (i + 0.5)) / w.pellets : 0;
      const jitter = (Math.random() - 0.5) * (w.pellets > 1 ? w.spread / w.pellets : w.spread);
      const ang = p.aim + base + jitter;
      const c = Math.cos(ang);
      const s = Math.sin(ang);
      const wallDist = this.map.raycast(ox, oy, ang, w.range);

      // Zombis atravesados por el segmento, ordenados por distancia.
      const hits: { z: Zombie; t: number }[] = [];
      for (const z of this.zombies) {
        if (z.dead) continue;
        const vx = z.x - ox;
        const vy = z.y - oy;
        const t = vx * c + vy * s;
        if (t < -z.def.radius || t > wallDist + z.def.radius) continue;
        const perp = Math.abs(vx * s - vy * c);
        if (perp < z.def.radius) hits.push({ z, t: Math.max(0, t - Math.sqrt(z.def.radius ** 2 - perp ** 2)) });
      }
      hits.sort((a, b) => a.t - b.t);
      let end = wallDist;
      const maxHits = 1 + w.pierce;
      for (let h = 0; h < hits.length && h < maxHits; h++) {
        this.damageZombie(hits[h].z, w.damage, p);
        if (h === maxHits - 1) end = hits[h].t;
      }
      this.shots.push({ pid: p.id, ox, oy, ex: ox + c * end, ey: oy + s * end, hit: hits.length > 0 });
    }
  }

  private throwGrenade(p: SimPlayer, distFrac: number): void {
    if (p.grenades <= 0 || p.grenadeCooldown > 0) return;
    const g = COMBAT.grenade;
    p.grenades--;
    p.grenadeCooldown = GRENADE_THROW_COOLDOWN;
    const dist = clamp(distFrac, 0, 1) * g.range;
    this.projectiles.push({
      id: this.nextProjId(), kind: PROJ_GRENADE, x: p.x, y: p.y,
      vx: Math.cos(p.aim) * g.speed, vy: Math.sin(p.aim) * g.speed,
      travel: Math.max(GRENADE_MIN_DIST, dist), fuse: g.fuse, ownerId: p.id, damage: p.setup.grenadeDamage,
    });
  }

  private useAbility(p: SimPlayer): void {
    if (p.abilityCd > 0) return;
    const ab = p.setup.ability;
    p.abilityCd = ab.cooldown;
    if (ab.id === 'heal') {
      const r = ab.radius ?? 200;
      for (const o of this.standing()) {
        if (Math.hypot(o.x - p.x, o.y - p.y) <= r) o.hp = Math.min(o.setup.maxHp, o.hp + ab.power);
      }
      this.fx.push({ kind: FX_HEAL, x: p.x, y: p.y, radius: r });
    } else {
      p.abilityTimer = ab.duration;
    }
  }

  private damagePlayer(p: SimPlayer, dmg: number, type: DamageType): void {
    if (!p.alive) return;
    let d = dmg * (1 - (p.setup.resist[type] ?? 0));
    if (p.abilityTimer > 0 && p.setup.ability.id === 'shield') d *= 1 - p.setup.ability.power;
    p.hp -= d;
    if (p.hp > 0) return;
    // Cae al suelo si queda algún compañero en pie que pueda revivirlo; si no, muere.
    if (this.standing().some((o) => o !== p)) {
      p.alive = false;
      p.downed = true;
      p.hp = 0;
      p.bleedTimer = COMBAT.revive.bleedOutSeconds;
      p.reviveProgress = 0;
      p.reloadTimer = 0;
      p.abilityTimer = 0;
    } else {
      this.killPlayer(p, true);
    }
  }

  private killPlayer(p: SimPlayer, countDeath: boolean): void {
    p.alive = false;
    p.downed = false;
    p.hp = 0;
    p.queue.length = 0;
    p.reloadTimer = 0;
    p.abilityTimer = 0;
    p.reviveProgress = 0;
    if (countDeath) p.deaths++;
    p.respawnTimer = this.mode.respawnSeconds > 0 ? this.mode.respawnSeconds : Infinity;
  }

  /** Reanimación: un compañero en pie cerca del caído lo levanta poco a poco. */
  private updateDowned(dt: number): void {
    const rv = COMBAT.revive;
    for (const p of this.players.values()) {
      if (!p.downed) continue;
      p.bleedTimer -= dt;
      let speed = 0;
      let helper: SimPlayer | null = null;
      for (const o of this.standing()) {
        if (Math.hypot(o.x - p.x, o.y - p.y) <= rv.radius + o.setup.radius && o.setup.reviveSpeed > speed) {
          speed = o.setup.reviveSpeed;
          helper = o;
        }
      }
      if (helper) p.reviveProgress += (dt / rv.reviveSeconds) * speed;
      if (p.reviveProgress >= 1) {
        p.downed = false;
        p.alive = true;
        p.hp = p.setup.maxHp * rv.hpFraction;
        p.reviveProgress = 0;
        helper!.revives++;
      } else if (p.bleedTimer <= 0) {
        this.killPlayer(p, true);
      }
    }
  }

  private updateRespawns(dt: number): void {
    for (const p of this.players.values()) {
      if (p.alive || p.downed) continue;
      p.respawnTimer -= dt;
      if (p.respawnTimer > 0) continue;
      const mates = this.standing();
      const at = mates.length ? mates[Math.floor(Math.random() * mates.length)] : this.pickPlayerSpawn();
      const pos = this.map.collideCircle(at.x, at.y, p.setup.radius);
      Object.assign(p, {
        x: pos.x, y: pos.y, alive: true, hp: p.setup.maxHp, respawnTimer: 0, cooldown: 0,
        ammo: p.setup.weapons.map((w) => w.magSize), grenades: p.setup.grenades,
      });
    }
  }

  private pickPlayerSpawn(): Vec2 {
    const spawns = this.map.playerSpawns;
    const taken = new Set([...this.players.values()].map((p) => `${p.x},${p.y}`));
    return spawns.find((s) => !taken.has(`${s.x},${s.y}`)) ?? spawns[0] ?? { x: 64, y: 64 };
  }

  // ───────────── Proyectiles ─────────────

  private nextProjId(): number {
    const id = this.nextProjectileId;
    this.nextProjectileId = id >= 65535 ? 1 : id + 1;
    return id;
  }

  private updateProjectiles(dt: number): void {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const pr = this.projectiles[i];
      if (pr.kind === PROJ_GRENADE) {
        // Rueda hasta su destino (o hasta un muro) y explota al acabar la mecha.
        if (pr.travel > 0) {
          const sp = Math.hypot(pr.vx, pr.vy);
          const step = Math.min(pr.travel, sp * dt);
          const nx = pr.x + (pr.vx / sp) * step;
          const ny = pr.y + (pr.vy / sp) * step;
          if (this.map.isSolidAt(nx, ny)) pr.travel = 0;
          else {
            pr.x = nx;
            pr.y = ny;
            pr.travel -= step;
          }
        }
        pr.fuse -= dt;
        if (pr.fuse <= 0) {
          this.explode(pr.x, pr.y, COMBAT.grenade.radius, pr.damage, null, this.players.get(pr.ownerId) ?? null, FX_GRENADE);
          this.projectiles.splice(i, 1);
        }
        continue;
      }
      // Ácido: vuela recto y salpica al tocar a un jugador o un muro.
      pr.x += pr.vx * dt;
      pr.y += pr.vy * dt;
      pr.travel -= dt;
      let hit = this.map.isSolidAt(pr.x, pr.y) || pr.travel <= 0;
      for (const p of this.standing()) {
        if (Math.hypot(p.x - pr.x, p.y - pr.y) < p.setup.radius + 8) {
          this.damagePlayer(p, pr.damage, 'toxic');
          hit = true;
          break;
        }
      }
      if (hit) {
        this.fx.push({ kind: FX_ACID, x: pr.x, y: pr.y, radius: 24 });
        this.projectiles.splice(i, 1);
      }
    }
  }

  /**
   * Explosión en área con caída lineal (100 % en el centro, 50 % en el borde).
   * playerDamage: daño a jugadores (null = no les afecta). zombieDamage se acredita a `by`.
   */
  private explode(x: number, y: number, radius: number, zombieDamage: number, playerDamage: { dmg: number; type: DamageType } | null, by: SimPlayer | null, fxKind: number): void {
    this.fx.push({ kind: fxKind, x, y, radius });
    if (by && zombieDamage > 0) {
      for (const z of this.zombies) {
        if (z.dead) continue;
        const d = Math.hypot(z.x - x, z.y - y) - z.def.radius;
        if (d < radius) this.damageZombie(z, zombieDamage * (1 - 0.5 * Math.max(0, d) / radius), by);
      }
    }
    if (playerDamage) {
      for (const p of this.standing()) {
        const d = Math.hypot(p.x - x, p.y - y) - p.setup.radius;
        if (d < radius) this.damagePlayer(p, playerDamage.dmg * (1 - 0.5 * Math.max(0, d) / radius), playerDamage.type);
      }
    }
  }

  // ───────────── Zombis ─────────────

  private updateSpawning(dt: number): void {
    const mode = this.mode;
    const extra = Math.max(0, this.players.size - 1);
    if (this.phase === PHASE.playing) {
      if (this.elapsed >= mode.surviveSeconds) {
        this.spawnBoss();
        return;
      }
      const rate = interpCurve(mode.spawnCurve, this.elapsed) * (1 + mode.playerScaling.spawnPerExtraPlayer * extra);
      this.spawnAcc += rate * dt;
      while (this.spawnAcc >= 1) {
        this.spawnAcc -= 1;
        if (this.zombies.length >= mode.maxAlive) continue;
        this.spawnZombie(this.pickEnemyType());
      }
    } else if (this.phase === PHASE.boss && mode.boss.escortPerSecond > 0) {
      this.escortAcc += mode.boss.escortPerSecond * dt;
      while (this.escortAcc >= 1) {
        this.escortAcc -= 1;
        if (this.zombies.length < mode.maxAlive) this.spawnZombie(this.pickEnemyType());
      }
    }
  }

  private pickEnemyType(): number {
    let entry = this.mode.mix[0];
    for (const m of this.mode.mix) if (m.t <= this.elapsed) entry = m;
    return enemyIndex(pickWeighted(entry.weights));
  }

  private pickZombieSpawn(far: boolean): Vec2 {
    const alive = this.standing();
    const minDist = (s: Vec2) => Math.min(Infinity, ...alive.map((p) => Math.hypot(p.x - s.x, p.y - s.y)));
    const spawns = this.map.zombieSpawns;
    if (far) return spawns.reduce((best, s) => (minDist(s) > minDist(best) ? s : best), spawns[0]);
    const safe = spawns.filter((s) => minDist(s) > SAFE_SPAWN_DIST);
    const pool = safe.length ? safe : spawns;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  private spawnZombie(type: number, at?: Vec2, hpMul = 1): Zombie {
    const def = ENEMIES[type];
    const sp = at ?? this.pickZombieSpawn(false);
    const pos = this.map.collideCircle(sp.x + (Math.random() - 0.5) * 24, sp.y + (Math.random() - 0.5) * 24, def.radius);
    const z: Zombie = {
      id: this.nextZombieId, type, def, x: pos.x, y: pos.y, angle: Math.random() * Math.PI * 2,
      hp: def.hp * hpMul, maxHp: def.hp * hpMul, speedMul: def.boss ? 1 : 0.9 + Math.random() * 0.2,
      attackTimer: 0, attackFlash: 0, state: 'chase', stateTimer: 0,
      chargeCooldown: def.charge ? def.charge.cooldown / 2 : 0, chargeHit: new Set(),
      rangedCooldown: def.ranged ? def.ranged.cooldown * Math.random() : 0, dead: false,
    };
    this.nextZombieId = this.nextZombieId >= 65535 ? 1 : this.nextZombieId + 1;
    this.zombies.push(z);
    return z;
  }

  private spawnBoss(): void {
    this.phase = PHASE.boss;
    const type = enemyIndex(this.mode.boss.enemy);
    const hpMul = 1 + this.mode.boss.hpPerExtraPlayer * Math.max(0, this.players.size - 1);
    this.bossId = this.spawnZombie(type, this.pickZombieSpawn(true), hpMul).id;
  }

  private damageZombie(z: Zombie, dmg: number, by: SimPlayer): void {
    if (z.dead || z.hp <= 0) return;
    z.hp -= dmg;
    if (z.hp > 0) return;
    z.dead = true;
    by.kills++;
    by.xpEarned += z.def.xp;
    by.cashEarned += z.def.cash;
    this.kills++;
    const drop = z.def.drop;
    if (drop && Math.random() < drop.chance) {
      const tier = boxIndex(pickWeighted(drop.boxes));
      // La caja del jefe va directa al equipo: su muerte termina la partida y nadie podría recogerla.
      if (tier >= 0 && z.id === this.bossId) this.collected[tier]++;
      else if (tier >= 0) {
        this.boxes.push({ id: this.nextBoxId, tier, x: z.x, y: z.y, ttl: LOOT.box.lifetimeSeconds });
        this.nextBoxId = this.nextBoxId >= 65535 ? 1 : this.nextBoxId + 1;
      }
    }
    // El Hinchado revienta al morir: quema a los jugadores cercanos y arrasa a los zombis de alrededor.
    if (z.def.explode) {
      const ex = z.def.explode;
      this.explode(z.x, z.y, ex.radius, ex.damage * EXPLODER_ZOMBIE_DAMAGE_MUL, { dmg: ex.damage, type: z.def.damageType }, by, FX_FIRE);
    }
    if (z.id === this.bossId) this.finish('victory');
  }

  private updateZombies(dt: number): void {
    const alive = this.standing();
    for (const z of this.zombies) {
      if (z.dead) continue;
      z.attackTimer = Math.max(0, z.attackTimer - dt);
      z.attackFlash = Math.max(0, z.attackFlash - dt);
      z.chargeCooldown = Math.max(0, z.chargeCooldown - dt);
      z.rangedCooldown = Math.max(0, z.rangedCooldown - dt);

      let target: SimPlayer | null = null;
      let best = Infinity;
      for (const p of alive) {
        const d = Math.hypot(p.x - z.x, p.y - z.y);
        if (d < best) {
          best = d;
          target = p;
        }
      }

      if (z.state === 'windup') {
        z.stateTimer -= dt;
        if (z.stateTimer <= 0) {
          z.state = 'charge';
          z.stateTimer = z.def.charge!.duration;
          z.chargeHit.clear();
        }
        continue;
      }

      if (z.state === 'charge') {
        const ch = z.def.charge!;
        const dx = Math.cos(z.angle) * ch.speed * dt;
        const dy = Math.sin(z.angle) * ch.speed * dt;
        const pos = this.map.moveCircle(z.x, z.y, dx, dy, z.def.radius);
        const blocked = Math.hypot(pos.x - z.x - dx, pos.y - z.y - dy) > 2;
        z.x = pos.x;
        z.y = pos.y;
        for (const p of alive) {
          if (!z.chargeHit.has(p.id) && Math.hypot(p.x - z.x, p.y - z.y) < z.def.radius + p.setup.radius) {
            z.chargeHit.add(p.id);
            this.damagePlayer(p, ch.damage, z.def.damageType);
          }
        }
        z.stateTimer -= dt;
        if (z.stateTimer <= 0 || blocked) {
          z.state = 'chase';
          z.chargeCooldown = ch.cooldown;
        }
        continue;
      }

      if (!target) continue;

      // Hinchado: detona solo al acercarse a un jugador (sin daño a zombis ni crédito).
      if (z.def.explode && best < z.def.explode.trigger + target.setup.radius) {
        z.dead = true;
        const ex = z.def.explode;
        this.explode(z.x, z.y, ex.radius, 0, { dmg: ex.damage, type: z.def.damageType }, null, FX_FIRE);
        continue;
      }

      const reach = z.def.radius + target.setup.radius + 6;
      if (best < reach && z.def.damage > 0) {
        z.angle = Math.atan2(target.y - z.y, target.x - z.x);
        if (z.attackTimer <= 0) {
          this.damagePlayer(target, z.def.damage, z.def.damageType);
          z.attackTimer = z.def.attackCooldown;
          z.attackFlash = 0.25;
        }
        continue;
      }

      const sightRange = Math.max(DIRECT_CHASE_DIST, z.def.charge ? 520 : 0, z.def.ranged ? z.def.ranged.range : 0);
      const los = best < sightRange && this.map.hasLineOfSight(z.x, z.y, target.x, target.y);

      if (z.def.charge && los && z.chargeCooldown <= 0 && best > reach * 1.5) {
        z.state = 'windup';
        z.stateTimer = z.def.charge.windup;
        z.angle = Math.atan2(target.y - z.y, target.x - z.x);
        continue;
      }

      // Escupidor: se queda a distancia y lanza ácido si tiene línea de visión.
      if (z.def.ranged && los && best <= z.def.ranged.range) {
        const rg = z.def.ranged;
        z.angle = Math.atan2(target.y - z.y, target.x - z.x);
        if (z.rangedCooldown <= 0) {
          z.rangedCooldown = rg.cooldown;
          z.attackFlash = 0.3;
          this.projectiles.push({
            id: this.nextProjId(), kind: PROJ_ACID, x: z.x, y: z.y,
            vx: Math.cos(z.angle) * rg.projectileSpeed, vy: Math.sin(z.angle) * rg.projectileSpeed,
            travel: ACID_LIFETIME, fuse: 0, ownerId: 0, damage: rg.damage,
          });
        }
        if (best < rg.keepDistance) {
          // Retrocede un poco para mantener la distancia.
          const sp = z.def.speed * 0.6 * dt;
          const pos = this.map.moveCircle(z.x, z.y, -Math.cos(z.angle) * sp, -Math.sin(z.angle) * sp, z.def.radius);
          z.x = pos.x;
          z.y = pos.y;
        }
        continue;
      }

      let goal: Vec2 | null = null;
      if (los && best < DIRECT_CHASE_DIST * (z.def.boss ? 4 : 1)) goal = target;
      else goal = this.flow.nextStep(z.x, z.y) ?? target;
      const gx = goal.x - z.x;
      const gy = goal.y - z.y;
      const gl = Math.hypot(gx, gy);
      if (gl < 0.5) continue;
      z.angle = Math.atan2(gy, gx);
      const sp = z.def.speed * z.speedMul * dt;
      const pos = this.map.moveCircle(z.x, z.y, (gx / gl) * sp, (gy / gl) * sp, z.def.radius);
      z.x = pos.x;
      z.y = pos.y;
    }
  }

  /** Separación suave entre zombis (rejilla espacial) y empuje fuera de los jugadores en pie. */
  private separate(): void {
    const cells = new Map<number, Zombie[]>();
    const key = (cx: number, cy: number) => cx * 4096 + cy;
    for (const z of this.zombies) {
      if (z.dead) continue;
      const k = key(Math.floor(z.x / SEPARATION_CELL), Math.floor(z.y / SEPARATION_CELL));
      let list = cells.get(k);
      if (!list) cells.set(k, (list = []));
      list.push(z);
    }
    for (const z of this.zombies) {
      if (z.dead) continue;
      const cx = Math.floor(z.x / SEPARATION_CELL);
      const cy = Math.floor(z.y / SEPARATION_CELL);
      const reachCells = z.def.radius > SEPARATION_CELL / 2 ? 2 : 1;
      for (let ox = -reachCells; ox <= reachCells; ox++) {
        for (let oy = -reachCells; oy <= reachCells; oy++) {
          const list = cells.get(key(cx + ox, cy + oy));
          if (!list) continue;
          for (const o of list) {
            if (o.id <= z.id) continue;
            const dx = o.x - z.x;
            const dy = o.y - z.y;
            const min = z.def.radius + o.def.radius;
            const d2 = dx * dx + dy * dy;
            if (d2 >= min * min || d2 < 1e-6) continue;
            const d = Math.sqrt(d2);
            const push = (min - d) * 0.5;
            const nx = dx / d;
            const ny = dy / d;
            // El jefe no se deja empujar.
            const zw = z.def.boss ? 0 : o.def.boss ? 1 : 0.5;
            const ow = 1 - zw;
            z.x -= nx * push * 2 * zw;
            z.y -= ny * push * 2 * zw;
            o.x += nx * push * 2 * ow;
            o.y += ny * push * 2 * ow;
          }
        }
      }
    }
    const alive = this.standing();
    for (const z of this.zombies) {
      if (z.dead) continue;
      if (!z.def.boss) {
        for (const p of alive) {
          const dx = z.x - p.x;
          const dy = z.y - p.y;
          const min = z.def.radius + p.setup.radius;
          const d2 = dx * dx + dy * dy;
          if (d2 >= min * min || d2 < 1e-6) continue;
          const d = Math.sqrt(d2);
          z.x += (dx / d) * (min - d);
          z.y += (dy / d) * (min - d);
        }
      }
      const pos = this.map.collideCircle(z.x, z.y, z.def.radius);
      z.x = pos.x;
      z.y = pos.y;
    }
  }

  /** Cajas: cualquier jugador en pie que pase por encima la recoge para todo el equipo. */
  private updateBoxes(dt: number): void {
    for (let i = this.boxes.length - 1; i >= 0; i--) {
      const b = this.boxes[i];
      b.ttl -= dt;
      const taken = this.standing().some((p) => Math.hypot(p.x - b.x, p.y - b.y) < LOOT.box.pickupRadius + p.setup.radius);
      if (taken) this.collected[b.tier]++;
      if (taken || b.ttl <= 0) this.boxes.splice(i, 1);
    }
  }

  /** Derrota cuando no queda nadie en pie (los caídos no cuentan). */
  private checkEnd(): void {
    if (this.result || this.players.size === 0) return;
    if (this.standing().length === 0) this.finish('defeat');
  }

  private finish(result: 'victory' | 'defeat'): void {
    this.phase = result === 'victory' ? PHASE.victory : PHASE.defeat;
    this.result = {
      result,
      elapsed: Math.round(this.elapsed),
      kills: this.kills,
      players: [...this.players.values()].map((p) => ({ id: p.id, name: p.name, kills: p.kills, deaths: p.deaths, revives: p.revives })),
    };
  }
}

function interpCurve(curve: { t: number; perSecond: number }[], t: number): number {
  if (t <= curve[0].t) return curve[0].perSecond;
  for (let i = 1; i < curve.length; i++) {
    const a = curve[i - 1];
    const b = curve[i];
    if (t <= b.t) return a.perSecond + ((b.perSecond - a.perSecond) * (t - a.t)) / (b.t - a.t);
  }
  return curve[curve.length - 1].perSecond;
}
