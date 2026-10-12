/** Estado de entrada combinado: teclado/ratón (GameScene) y controles táctiles (HudScene). */
export const input = {
  usingTouch: false,
  kbMove: { x: 0, y: 0 },
  touchMove: { x: 0, y: 0 },
  mouseAim: 0,
  mouseFire: false,
  touchAim: null as number | null,
  touchFire: false,
  weaponSlot: 0,
  weaponCount: 1,
  reloadRequested: false,
  grenadeRequested: false,
  /** Distancia del lanzamiento como fracción del alcance (ratón: hasta el cursor; táctil: máximo). */
  grenadeDist: 1,
  abilityRequested: false,
  lastAim: 0,

  move(): { x: number; y: number } {
    return this.usingTouch ? this.touchMove : this.kbMove;
  },

  aim(): number {
    if (!this.usingTouch) return (this.lastAim = this.mouseAim);
    if (this.touchAim !== null) return (this.lastAim = this.touchAim);
    // Sin apuntar con el stick derecho: mirar hacia donde se camina.
    const m = this.touchMove;
    if (Math.hypot(m.x, m.y) > 0.2) this.lastAim = Math.atan2(m.y, m.x);
    return this.lastAim;
  },

  fire(): boolean {
    return this.usingTouch ? this.touchFire : this.mouseFire;
  },

  selectWeapon(slot: number): void {
    if (slot >= 0 && slot < this.weaponCount) this.weaponSlot = slot;
  },

  cycleWeapon(): void {
    this.weaponSlot = (this.weaponSlot + 1) % this.weaponCount;
  },

  consumeReload(): boolean {
    const r = this.reloadRequested;
    this.reloadRequested = false;
    return r;
  },

  consumeGrenade(): boolean {
    const g = this.grenadeRequested;
    this.grenadeRequested = false;
    return g;
  },

  consumeAbility(): boolean {
    const a = this.abilityRequested;
    this.abilityRequested = false;
    return a;
  },

  reset(weaponCount: number): void {
    this.weaponCount = weaponCount;
    this.weaponSlot = 0;
    this.kbMove = { x: 0, y: 0 };
    this.touchMove = { x: 0, y: 0 };
    this.touchAim = null;
    this.touchFire = false;
    this.mouseFire = false;
    this.reloadRequested = false;
    this.grenadeRequested = false;
    this.abilityRequested = false;
  },
};
