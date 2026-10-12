import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  CLASSES,
  LOADOUT_SLOTS,
  buildCombatSetup,
  canEquip,
  getClassSafe,
  levelFromXp,
  matchRewards,
  rollBoxItem,
  sellValue,
  skillBlockReason,
  skillPointsFor,
  upgradeCost,
  xpForLevel,
  type CombatSetup,
  type ItemData,
  type PlayerResult,
  type ProfileView,
  type RewardView,
} from '@horda/shared';
import { Store } from './db';

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

const USERNAME_RE = /^[A-Za-z0-9_]{3,16}$/;
const MIN_PASSWORD = 4;
const MAX_PASSWORD = 64;
/** El equipo inicial es igual para todas las clases. */
const STARTER = CLASSES[0].loadout;

export class AccountError extends Error {}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, 32);
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [, saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scryptAsync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(actual, expected);
}

/** Cuentas, perfiles, inventario, habilidades y recompensas. Todas las reglas numéricas vienen de @horda/shared. */
export class Accounts {
  constructor(readonly store: Store) {}

  // ───────────── Autenticación ─────────────

  async register(username: string, password: string): Promise<{ token: string; userId: number }> {
    username = username.trim();
    if (!USERNAME_RE.test(username)) throw new AccountError('El usuario debe tener 3-16 caracteres: letras, números o _');
    if (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
      throw new AccountError(`La contraseña debe tener entre ${MIN_PASSWORD} y ${MAX_PASSWORD} caracteres`);
    }
    if (this.store.userByName(username)) throw new AccountError('Ese nombre de usuario ya existe');
    const hash = await hashPassword(password);
    const userId = this.store.tx(() => {
      const id = this.store.createUser(username, hash);
      const loadout = STARTER.map((base) => this.store.addItem(id, { base, rarity: 'common', level: 0, roll: 1 }).id);
      this.store.setLoadout(id, loadout);
      return id;
    });
    return { token: this.newSession(userId), userId };
  }

  async login(username: string, password: string): Promise<{ token: string; userId: number }> {
    const user = this.store.userByName(username.trim());
    if (!user || !(await verifyPassword(password, user.pass_hash))) throw new AccountError('Usuario o contraseña incorrectos');
    this.migrateProfile(user.id);
    return { token: this.newSession(user.id), userId: user.id };
  }

  resume(token: string): number {
    const userId = typeof token === 'string' && token.length === 64 ? this.store.sessionUser(token) : undefined;
    if (!userId) throw new AccountError('La sesión ha caducado, vuelve a entrar');
    this.migrateProfile(userId);
    return userId;
  }

  logout(token: string): void {
    this.store.deleteSession(token);
  }

  private newSession(userId: number): string {
    const token = randomBytes(32).toString('hex');
    this.store.createSession(token, userId);
    return token;
  }

  /** Cuentas de versiones anteriores: rellena las ranuras nuevas del equipo (p. ej. la armadura). */
  private migrateProfile(userId: number): void {
    const loadout = this.loadout(userId);
    if (loadout.length >= LOADOUT_SLOTS.length && loadout.every((id, slot) => this.validInSlot(userId, id, slot))) return;
    this.store.tx(() => {
      const items = this.store.items(userId);
      LOADOUT_SLOTS.forEach((_, slot) => {
        if (this.validInSlot(userId, loadout[slot], slot)) return;
        const spare = items.find((i) => canEquip(i, slot) && !loadout.includes(i.id));
        loadout[slot] = spare ? spare.id : this.store.addItem(userId, { base: STARTER[slot], rarity: 'common', level: 0, roll: 1 }).id;
      });
      this.store.setLoadout(userId, loadout);
    });
  }

  private validInSlot(userId: number, itemId: number | undefined, slot: number): boolean {
    const item = itemId ? this.store.item(userId, itemId) : undefined;
    return !!item && canEquip(item, slot);
  }

  // ───────────── Perfil ─────────────

  username(userId: number): string {
    return this.store.userById(userId)?.username ?? `#${userId}`;
  }

  level(userId: number): number {
    return levelFromXp(this.store.profile(userId).xp);
  }

  classId(userId: number): string {
    return getClassSafe(this.store.profile(userId).class).id;
  }

  profile(userId: number): ProfileView {
    const p = this.store.profile(userId);
    const level = levelFromXp(p.xp);
    return {
      username: this.username(userId),
      level,
      xp: p.xp,
      xpLevelStart: xpForLevel(level),
      xpNextLevel: xpForLevel(level + 1),
      cash: p.cash,
      classId: getClassSafe(p.class).id,
      skillPoints: skillPointsFor(level),
      skills: this.store.skills(userId),
      loadout: this.loadout(userId),
      items: this.store.items(userId),
      stats: { games: p.games, wins: p.wins, kills: p.kills },
    };
  }

  private loadout(userId: number): number[] {
    try {
      const l = JSON.parse(this.store.profile(userId).loadout);
      return Array.isArray(l) ? l.map(Number) : [];
    } catch {
      return [];
    }
  }

  /** Equipo efectivo para la próxima partida: clase elegida, nivel, habilidades y objetos. */
  combatSetup(userId: number): CombatSetup {
    const p = this.store.profile(userId);
    const classId = getClassSafe(p.class).id;
    const items = this.loadout(userId).map((id) => this.store.item(userId, id));
    return buildCombatSetup(classId, levelFromXp(p.xp), this.store.skills(userId)[classId], items);
  }

  // ───────────── Clase y habilidades ─────────────

  setClass(userId: number, classId: string): void {
    if (!CLASSES.some((c) => c.id === classId)) throw new AccountError('Clase desconocida');
    this.store.setClass(userId, classId);
  }

  learnSkill(userId: number, classId: string, skillId: string): void {
    if (!CLASSES.some((c) => c.id === classId)) throw new AccountError('Clase desconocida');
    this.store.tx(() => {
      const ranks = this.store.skills(userId)[classId] ?? {};
      const reason = skillBlockReason(classId, ranks, skillId, this.level(userId));
      if (reason) throw new AccountError(reason);
      this.store.setSkillRank(userId, classId, skillId, (ranks[skillId] ?? 0) + 1);
    });
  }

  resetSkills(userId: number, classId: string): void {
    this.store.resetSkills(userId, classId);
  }

  // ───────────── Arsenal ─────────────

  equip(userId: number, slot: number, itemId: number): void {
    const item = this.store.item(userId, itemId);
    if (!item) throw new AccountError('Ese objeto no existe');
    if (!canEquip(item, slot)) throw new AccountError('Ese objeto no va en esa ranura');
    const loadout = this.loadout(userId);
    // Si ya estaba en otra ranura (dos principales), se intercambian.
    const prev = loadout.indexOf(itemId);
    if (prev >= 0 && prev !== slot) loadout[prev] = loadout[slot];
    loadout[slot] = itemId;
    this.store.setLoadout(userId, loadout);
  }

  upgrade(userId: number, itemId: number): void {
    this.store.tx(() => {
      const item = this.store.item(userId, itemId);
      if (!item) throw new AccountError('Ese objeto no existe');
      const cost = upgradeCost(item);
      if (cost === null) throw new AccountError('Ya está al nivel máximo');
      if (this.store.profile(userId).cash < cost) throw new AccountError('No tienes dinero suficiente');
      this.store.addCash(userId, -cost);
      this.store.setItemLevel(userId, itemId, item.level + 1);
    });
  }

  sell(userId: number, itemId: number): void {
    this.store.tx(() => {
      const item = this.store.item(userId, itemId);
      if (!item) throw new AccountError('Ese objeto no existe');
      if (this.loadout(userId).includes(itemId)) throw new AccountError('No puedes vender un objeto equipado');
      this.store.deleteItem(userId, itemId);
      this.store.addCash(userId, sellValue(item));
    });
  }

  // ───────────── Recompensas ─────────────

  /** Aplica XP, dinero y abre las cajas recogidas. Las cajas son del equipo: cada jugador recibe todas. */
  grantRewards(userId: number, result: 'victory' | 'defeat', elapsed: number, perf: PlayerResult, boxes: number[]): RewardView {
    return this.store.tx(() => {
      const before = levelFromXp(this.store.profile(userId).xp);
      const { xp, cash } = matchRewards(result, elapsed, perf);
      this.store.addMatch(userId, xp, cash, result === 'victory', perf.kills);
      const items: ItemData[] = [];
      boxes.forEach((count, tier) => {
        for (let i = 0; i < count; i++) items.push(this.store.addItem(userId, rollBoxItem(tier, before)));
      });
      const after = levelFromXp(this.store.profile(userId).xp);
      return { result, xp, cash, levelBefore: before, levelAfter: after, items };
    });
  }
}

const dbPath = process.env.HORDA_DB || fileURLToPath(new URL('../data/horda.db', import.meta.url));
export const accounts = new Accounts(new Store(dbPath));
