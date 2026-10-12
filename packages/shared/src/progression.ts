// Reglas de progresión: niveles, objetos, mejoras, cajas, habilidades y recompensas.
// Compartidas para que el cliente muestre (y prediga) exactamente los mismos números que aplica el servidor.
import {
  ARMORS,
  CLASSES,
  COMBAT,
  DAMAGE_TYPES,
  LOOT,
  SKILLS,
  WEAPONS,
  classIndex,
  getArmor,
  getClass,
  getWeapon,
  isArmor,
  type AbilityDef,
  type ArmorDef,
  type ClassDef,
  type ItemSlot,
  type RarityDef,
  type Resist,
  type SkillDef,
  type StatKey,
  type WeaponDef,
} from './data';

/** Un objeto del inventario: arma o armadura. */
export interface ItemData {
  id: number;
  /** Id del arma (weapons.json) o de la armadura (armors.json). */
  base: string;
  rarity: string;
  /** Nivel de mejora (0..maxLevel). */
  level: number;
  /** Variación aleatoria al salir de la caja. */
  roll: number;
}

/** Rangos aprendidos por clase: { assault: { quick_trigger: 3 } }. */
export type SkillRanks = Record<string, Record<string, number>>;

export interface ProfileView {
  username: string;
  level: number;
  xp: number;
  /** XP total al empezar el nivel actual y para alcanzar el siguiente. */
  xpLevelStart: number;
  xpNextLevel: number;
  cash: number;
  /** Clase elegida para la próxima partida. */
  classId: string;
  /** Puntos de habilidad disponibles en cada clase (nivel - 1). */
  skillPoints: number;
  skills: SkillRanks;
  /** Ids de objeto equipados: [sidearm, primary, primary, armor]. */
  loadout: number[];
  items: ItemData[];
  stats: { games: number; wins: number; kills: number };
}

export interface RewardView {
  result: 'victory' | 'defeat';
  xp: number;
  cash: number;
  levelBefore: number;
  levelAfter: number;
  items: ItemData[];
}

/** Rendimiento de un jugador en una partida (lo produce la simulación). */
export interface PlayerResult {
  id: number;
  kills: number;
  deaths: number;
  revives: number;
  xpEarned: number;
  cashEarned: number;
}

export const LOADOUT_SLOTS: ItemSlot[] = ['sidearm', 'primary', 'primary', 'armor'];
export const SLOT_NAMES = ['Arma corta', 'Principal 1', 'Principal 2', 'Armadura'];
export const WEAPON_SLOTS = 3;

// ───────────── Niveles ─────────────

/** XP total necesaria para llegar a un nivel (nivel 1 = 0). */
export function xpForLevel(level: number): number {
  const { base, exponent } = LOOT.levels;
  return Math.round(base * Math.pow(Math.max(0, level - 1), exponent));
}

export function levelFromXp(xp: number): number {
  let level = 1;
  while (level < LOOT.levels.max && xp >= xpForLevel(level + 1)) level++;
  return level;
}

// ───────────── Objetos ─────────────

export function rarityDef(id: string): RarityDef {
  return LOOT.rarities.find((r) => r.id === id) ?? LOOT.rarities[0];
}

function rarityIndex(id: string): number {
  return Math.max(0, LOOT.rarities.findIndex((r) => r.id === id));
}

export function itemSlotKind(item: Pick<ItemData, 'base'>): ItemSlot {
  return isArmor(item.base) ? 'armor' : getWeapon(item.base).slot;
}

/** Multiplicador total de un objeto: rareza × tirada × mejoras. */
function itemMul(item: ItemData): number {
  return rarityDef(item.rarity).damageMul * item.roll * (1 + LOOT.upgrade.damagePerLevel * item.level);
}

export function itemName(item: ItemData): string {
  const base = isArmor(item.base) ? getArmor(item.base).name : getWeapon(item.base).name;
  return item.level > 0 ? `${base} +${item.level}` : base;
}

/** Arma con las estadísticas del objeto (sin habilidades de clase). */
export function itemWeapon(item: ItemData): WeaponDef {
  const base = getWeapon(item.base);
  return { ...base, name: itemName(item), damage: Math.round(base.damage * itemMul(item) * 10) / 10 };
}

/** Armadura con las resistencias del objeto (sin habilidades de clase). */
export function itemArmor(item: ItemData): ArmorDef {
  const base = getArmor(item.base);
  const mul = itemMul(item);
  const resist = Object.fromEntries(
    DAMAGE_TYPES.map((t) => [t, Math.min(COMBAT.resistCap, Math.round(base.resist[t] * mul * 1000) / 1000)]),
  ) as Resist;
  return { ...base, name: itemName(item), resist };
}

/** Coste de subir un nivel más, o null si ya está al máximo. */
export function upgradeCost(item: ItemData): number | null {
  const u = LOOT.upgrade;
  if (item.level >= u.maxLevel) return null;
  return Math.round(u.baseCost * (1 + u.rarityCostStep * rarityIndex(item.rarity)) * Math.pow(u.costGrowth, item.level));
}

export function sellValue(item: ItemData): number {
  return Math.round(rarityDef(item.rarity).value * (1 + 0.25 * item.level));
}

export function canEquip(item: Pick<ItemData, 'base'>, slot: number): boolean {
  return LOADOUT_SLOTS[slot] !== undefined && itemSlotKind(item) === LOADOUT_SLOTS[slot];
}

// ───────────── Cajas ─────────────

export function boxIndex(id: string): number {
  return LOOT.boxes.findIndex((b) => b.id === id);
}

export function pickWeighted(weights: Record<string, number>, rnd: () => number = Math.random): string {
  const entries = Object.entries(weights).filter(([, w]) => w > 0);
  const total = entries.reduce((a, [, w]) => a + w, 0);
  let r = rnd() * total;
  for (const [id, w] of entries) {
    r -= w;
    if (r <= 0) return id;
  }
  return entries[entries.length - 1][0];
}

/** Abre una caja: rareza según la caja; arma o armadura entre las disponibles para el nivel del jugador. */
export function rollBoxItem(boxTier: number, playerLevel: number, rnd: () => number = Math.random): Omit<ItemData, 'id'> {
  const box = LOOT.boxes[boxTier] ?? LOOT.boxes[0];
  const rarity = pickWeighted(box.rarities, rnd);
  const armor = rnd() < LOOT.box.armorChance;
  const pool: { id: string; minLevel: number }[] = (armor ? ARMORS : WEAPONS).filter((w) => w.minLevel <= playerLevel);
  const base = pool[Math.floor(rnd() * pool.length)] ?? WEAPONS[0];
  const [lo, hi] = LOOT.rollRange;
  const roll = Math.round((lo + rnd() * (hi - lo)) * 1000) / 1000;
  return { base: base.id, rarity, level: 0, roll };
}

// ───────────── Habilidades ─────────────

export function skillTree(classId: string): SkillDef[] {
  return SKILLS.trees[classId] ?? [];
}

/** Un punto por nivel a partir del 2, en cada clase. */
export function skillPointsFor(level: number): number {
  return Math.max(0, level - 1);
}

export function spentPoints(ranks: Record<string, number> = {}): number {
  return Object.values(ranks).reduce((a, b) => a + b, 0);
}

/** null si se puede subir un rango más; si no, el motivo. */
export function skillBlockReason(classId: string, ranks: Record<string, number>, skillId: string, level: number): string | null {
  const skill = skillTree(classId).find((s) => s.id === skillId);
  if (!skill) return 'Habilidad desconocida';
  if ((ranks[skillId] ?? 0) >= skill.maxRank) return 'Ya está al máximo';
  if (spentPoints(ranks) >= skillPointsFor(level)) return 'No te quedan puntos';
  const need = SKILLS.tierRequirements[skill.tier - 1] ?? 0;
  if (spentPoints(ranks) < need) return `Necesitas ${need} puntos en el árbol`;
  return null;
}

export function statTotals(classId: string, ranks: Record<string, number> = {}): Record<StatKey, number> {
  const totals: Record<string, number> = {};
  for (const s of skillTree(classId)) totals[s.stat] = (totals[s.stat] ?? 0) + s.perRank * (ranks[s.id] ?? 0);
  return totals as Record<StatKey, number>;
}

// ───────────── Equipo de combate ─────────────

/** Todo lo que la simulación necesita de un jugador: lo calculan igual servidor y cliente. */
export interface CombatSetup {
  classId: string;
  classIndex: number;
  weapons: WeaponDef[];
  armorName: string;
  maxHp: number;
  speed: number;
  radius: number;
  resist: Resist;
  grenades: number;
  grenadeDamage: number;
  ability: AbilityDef;
  reviveSpeed: number;
}

/**
 * Equipo efectivo: clase + nivel + habilidades + objetos equipados.
 * Si falta un objeto en una ranura, se usa el común inicial de la clase.
 */
export function buildCombatSetup(
  classId: string,
  level: number,
  ranks: Record<string, number> | undefined,
  loadout: (ItemData | undefined)[],
): CombatSetup {
  const cls: ClassDef = CLASSES.find((c) => c.id === classId) ?? CLASSES[0];
  const st = statTotals(cls.id, ranks);
  const s = (k: StatKey) => st[k] ?? 0;
  const fallback = (slot: number): ItemData => ({ id: 0, base: cls.loadout[slot], rarity: 'common', level: 0, roll: 1 });
  const slotItem = (slot: number) => {
    const item = loadout[slot];
    return item && canEquip(item, slot) ? item : fallback(slot);
  };

  const weapons = [0, 1, 2].map((slot) => {
    const w = itemWeapon(slotItem(slot));
    return {
      ...w,
      damage: Math.round(w.damage * (1 + s('damage')) * 10) / 10,
      fireRate: Math.round(w.fireRate * (1 + s('fireRate')) * 100) / 100,
      magSize: Math.max(1, Math.round(w.magSize * (1 + s('mag')))),
      reloadTime: Math.round((w.reloadTime / (1 + s('reload'))) * 100) / 100,
    };
  });
  const armor = itemArmor(slotItem(3));
  const resist = Object.fromEntries(
    Object.entries(armor.resist).map(([t, v]) => [t, Math.min(COMBAT.resistCap, Math.round((v + s('armor')) * 1000) / 1000)]),
  ) as Resist;

  const ab = cls.ability;
  const ability: AbilityDef = {
    ...ab,
    cooldown: Math.round(ab.cooldown * Math.max(0.3, 1 - s('abilityCooldown')) * 10) / 10,
    power: ab.id === 'shield' ? Math.min(0.85, ab.power + s('abilityPower')) : Math.round(ab.power * (1 + s('abilityPower')) * 100) / 100,
  };

  return {
    classId: cls.id,
    classIndex: classIndex(cls.id),
    weapons,
    armorName: armor.name,
    maxHp: cls.hp + LOOT.levels.hpPerLevel * (level - 1) + s('hp'),
    speed: Math.round(cls.speed * (1 + s('speed') + armor.speed)),
    radius: cls.radius,
    resist,
    grenades: cls.grenades + s('grenades'),
    grenadeDamage: Math.round(COMBAT.grenade.damage * (1 + s('grenadeDamage'))),
    ability,
    reviveSpeed: Math.round(cls.reviveSpeed * (1 + s('reviveSpeed')) * 100) / 100,
  };
}

/** Velocidad de movimiento real (la Adrenalina acelera). Igual en servidor y predicción del cliente. */
export function moveSpeed(setup: CombatSetup, abilityActive: boolean): number {
  return abilityActive && setup.ability.id === 'adrenaline' ? setup.speed * (1 + (setup.ability.power * 2) / 3) : setup.speed;
}

export function getClassSafe(id: string): ClassDef {
  try {
    return getClass(id);
  } catch {
    return CLASSES[0];
  }
}

// ───────────── Recompensas ─────────────

export function matchRewards(result: 'victory' | 'defeat', elapsed: number, p: PlayerResult): { xp: number; cash: number } {
  const r = LOOT.rewards;
  const win = result === 'victory';
  return {
    xp: Math.round(p.xpEarned + elapsed * r.xpPerSecond + (win ? r.victoryXp : r.defeatXp) + p.revives * 10),
    cash: Math.round(p.cashEarned + (win ? r.victoryCash : 0)),
  };
}
