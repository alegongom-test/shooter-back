// Todo el contenido del juego vive en /data como JSON.
// Añadir un arma, armadura, enemigo o habilidad = editar su JSON. Añadir un mapa o un modo = crear el JSON y registrarlo aquí.
import weaponsJson from '../../../data/weapons.json';
import armorsJson from '../../../data/armors.json';
import enemiesJson from '../../../data/enemies.json';
import classesJson from '../../../data/classes.json';
import skillsJson from '../../../data/skills.json';
import combatJson from '../../../data/combat.json';
import arenaMap from '../../../data/maps/arena.json';
import surviveBossMode from '../../../data/modes/survive_boss.json';
import lootJson from '../../../data/loot.json';

export type DamageType = 'physical' | 'fire' | 'toxic';
export const DAMAGE_TYPES: DamageType[] = ['physical', 'fire', 'toxic'];
export const DAMAGE_TYPE_NAMES: Record<DamageType, string> = { physical: 'Físico', fire: 'Fuego', toxic: 'Tóxico' };
export type Resist = Record<DamageType, number>;

/** Tipo de ranura: el equipo es 1 'sidearm' + 2 'primary' + 1 'armor'. */
export type ItemSlot = 'sidearm' | 'primary' | 'armor';
export type WeaponSlot = Exclude<ItemSlot, 'armor'>;

export interface WeaponDef {
  id: string;
  name: string;
  slot: WeaponSlot;
  /** Nivel de jugador a partir del cual puede salir en cajas. */
  minLevel: number;
  damage: number;
  /** Disparos por segundo. */
  fireRate: number;
  magSize: number;
  /** Segundos. */
  reloadTime: number;
  /** Proyectiles por disparo (escopeta > 1). */
  pellets: number;
  /** Apertura total del cono en radianes. */
  spread: number;
  range: number;
  /** Enemigos extra que atraviesa cada proyectil. */
  pierce: number;
}

export interface ArmorDef {
  id: string;
  name: string;
  minLevel: number;
  /** Fracción de daño que bloquea por tipo (0.25 = 25 %). */
  resist: Resist;
  /** Modificador de velocidad (-0.08 = 8 % más lento). */
  speed: number;
}

export interface ChargeDef {
  cooldown: number;
  windup: number;
  speed: number;
  duration: number;
  damage: number;
}

export interface RangedDef {
  range: number;
  /** Distancia a la que intenta quedarse. */
  keepDistance: number;
  cooldown: number;
  projectileSpeed: number;
  damage: number;
  projectileRadius: number;
}

export interface ExplodeDef {
  radius: number;
  damage: number;
  /** Distancia a un jugador a la que detona solo. */
  trigger: number;
}

export interface EnemyDef {
  id: string;
  name: string;
  /** Clave de sprite: el cliente busca assets/sprites/<sprite>.png y, si no existe, dibuja un marcador. */
  sprite: string;
  tint: string;
  hp: number;
  speed: number;
  radius: number;
  damage: number;
  attackCooldown: number;
  damageType: DamageType;
  /** Recompensas para quien lo mata. */
  xp: number;
  cash: number;
  /** Probabilidad de soltar una caja y peso de cada tipo de caja. */
  drop?: { chance: number; boxes: Record<string, number> };
  boss?: boolean;
  charge?: ChargeDef;
  ranged?: RangedDef;
  explode?: ExplodeDef;
}

export type AbilityId = 'adrenaline' | 'heal' | 'shield';

export interface AbilityDef {
  id: AbilityId;
  name: string;
  description: string;
  cooldown: number;
  /** 0 = instantánea. */
  duration: number;
  /** Adrenalina: +cadencia (y 2/3 de eso en velocidad). Curación: vida curada. Escudo: reducción de daño. */
  power: number;
  radius?: number;
}

export interface ClassDef {
  id: string;
  name: string;
  description: string;
  sprite: string;
  hp: number;
  speed: number;
  radius: number;
  grenades: number;
  /** Multiplicador de velocidad al revivir compañeros. */
  reviveSpeed: number;
  ability: AbilityDef;
  /** Equipo inicial (común) de una cuenta nueva: sidearm, primary, primary, armor. */
  loadout: string[];
}

/** Estadísticas que modifican las habilidades del árbol. */
export type StatKey =
  | 'damage'
  | 'fireRate'
  | 'reload'
  | 'mag'
  | 'hp'
  | 'speed'
  | 'armor'
  | 'grenades'
  | 'grenadeDamage'
  | 'abilityCooldown'
  | 'abilityPower'
  | 'reviveSpeed';

export interface SkillDef {
  id: string;
  name: string;
  description: string;
  /** 1..3. Para desbloquear el tier N hay que gastar tierRequirements[N-1] puntos en el árbol. */
  tier: number;
  maxRank: number;
  stat: StatKey;
  perRank: number;
}

export interface SkillsDef {
  tierRequirements: number[];
  trees: Record<string, SkillDef[]>;
}

export interface CombatDef {
  /** Resistencia máxima por tipo de daño. */
  resistCap: number;
  grenade: { damage: number; radius: number; fuse: number; range: number; speed: number; regenSeconds: number };
  revive: { bleedOutSeconds: number; reviveSeconds: number; radius: number; hpFraction: number };
}

export interface ModeDef {
  id: string;
  name: string;
  map: string;
  surviveSeconds: number;
  maxAlive: number;
  /** 0 = sin reaparición. */
  respawnSeconds: number;
  playerScaling: { spawnPerExtraPlayer: number };
  /** Zombis por segundo en función del tiempo (interpolación lineal). */
  spawnCurve: { t: number; perSecond: number }[];
  /** Pesos de cada tipo de enemigo a partir del segundo t. */
  mix: { t: number; weights: Record<string, number> }[];
  boss: { enemy: string; hpPerExtraPlayer: number; escortPerSecond: number };
}

export interface MapDef {
  id: string;
  name: string;
  tileSize: number;
  floorColor?: string;
  wallColor?: string;
  /** '#' muro, '.' suelo, 'P' aparición de jugador, 'Z' aparición de zombis. */
  rows: string[];
}

export interface RarityDef {
  id: string;
  name: string;
  color: string;
  /** Multiplica el daño de las armas y la resistencia de las armaduras. */
  damageMul: number;
  /** Precio de venta base. */
  value: number;
}

export interface BoxDef {
  id: string;
  name: string;
  color: string;
  /** Pesos de rareza al abrirla. */
  rarities: Record<string, number>;
}

export interface LootDef {
  rarities: RarityDef[];
  /** El índice en este array es el "tier" que viaja por red. */
  boxes: BoxDef[];
  box: { lifetimeSeconds: number; pickupRadius: number; armorChance: number };
  upgrade: { maxLevel: number; damagePerLevel: number; baseCost: number; costGrowth: number; rarityCostStep: number };
  rollRange: [number, number];
  rewards: { xpPerSecond: number; victoryXp: number; defeatXp: number; victoryCash: number };
  levels: { base: number; exponent: number; max: number; hpPerLevel: number };
}

export const WEAPONS = weaponsJson as unknown as WeaponDef[];
export const ARMORS = armorsJson as unknown as ArmorDef[];
export const LOOT = lootJson as unknown as LootDef;
export const COMBAT = combatJson as unknown as CombatDef;
export const SKILLS = skillsJson as unknown as SkillsDef;
/** El índice en este array es el "type" que viaja por red. */
export const ENEMIES = enemiesJson as unknown as EnemyDef[];
/** El índice en este array es la clase que viaja por red. */
export const CLASSES = classesJson as unknown as ClassDef[];
export const MAPS: Record<string, MapDef> = { [arenaMap.id]: arenaMap as unknown as MapDef };
export const MODES: Record<string, ModeDef> = { [surviveBossMode.id]: surviveBossMode as unknown as ModeDef };

export const DEFAULT_MODE = 'survive_boss';
export const DEFAULT_CLASS = CLASSES[0].id;

function byId<T extends { id: string }>(list: T[], id: string, what: string): T {
  const found = list.find((x) => x.id === id);
  if (!found) throw new Error(`${what} desconocido: ${id}`);
  return found;
}

export const getWeapon = (id: string) => byId(WEAPONS, id, 'Arma');
export const getArmor = (id: string) => byId(ARMORS, id, 'Armadura');
export const isArmor = (id: string) => ARMORS.some((a) => a.id === id);
export const getClass = (id: string) => byId(CLASSES, id, 'Clase');
export const classIndex = (id: string) => Math.max(0, CLASSES.findIndex((c) => c.id === id));
export const enemyIndex = (id: string) => {
  const i = ENEMIES.findIndex((e) => e.id === id);
  if (i < 0) throw new Error(`Enemigo desconocido: ${id}`);
  return i;
};

export function getMode(id: string): ModeDef {
  const m = MODES[id];
  if (!m) throw new Error(`Modo desconocido: ${id}`);
  return m;
}

export function getMap(id: string): MapDef {
  const m = MAPS[id];
  if (!m) throw new Error(`Mapa desconocido: ${id}`);
  return m;
}
