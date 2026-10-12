import Phaser from 'phaser';
import {
  CLASSES,
  COMBAT,
  ENEMIES,
  FX_ACID,
  FX_FIRE,
  FX_GRENADE,
  FX_HEAL,
  LOOT,
  PROJ_GRENADE,
  PLAYER_COLORS,
  TICK_DT,
  TICK_MS,
  ZFLAG_ATTACK,
  ZFLAG_CHARGE,
  ZFLAG_WINDUP,
  lerp,
  round3,
  type SnapPlayer,
  type SnapZombie,
} from '@horda/shared';
import { input } from '../input';
import { session } from '../session';
import { ensureTextures, hexColor, preloadSprites, spriteScale } from '../textures';

const MAX_DECALS = 160;
const TRACER_LIFE = 0.07;

interface PlayerView {
  body: Phaser.GameObjects.Image;
  label: Phaser.GameObjects.Text;
}

interface Tracer {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  life: number;
  mine: boolean;
}

/** Mundo: mapa, entidades, disparos. Lleva el bucle fijo de 20 Hz que envía inputs al servidor. */
export class GameScene extends Phaser.Scene {
  private acc = 0;
  private players = new Map<number, PlayerView>();
  private zombies = new Map<number, Phaser.GameObjects.Image>();
  private boxes = new Map<number, Phaser.GameObjects.Image>();
  private lastZombiePos = new Map<number, { x: number; y: number; r: number }>();
  private decals: Phaser.GameObjects.Image[] = [];
  private tracers: Tracer[] = [];
  private tracerGfx!: Phaser.GameObjects.Graphics;
  /** Anillos de reanimación, auras de habilidad y efectos de explosión. */
  private fxGfx!: Phaser.GameObjects.Graphics;
  private effects: { kind: number; x: number; y: number; radius: number; life: number; max: number }[] = [];
  private projectiles = new Map<number, Phaser.GameObjects.Image>();
  private lastFxTick = 0;
  private keys!: Record<string, Phaser.Input.Keyboard.Key>;
  private localCooldown = 0;
  private renderSelf = { x: 0, y: 0 };

  constructor() {
    super('game');
  }

  preload(): void {
    preloadSprites(this);
  }

  create(): void {
    this.acc = 0;
    this.players.clear();
    this.zombies.clear();
    this.boxes.clear();
    this.projectiles.clear();
    this.effects = [];
    this.lastFxTick = 0;
    this.lastZombiePos.clear();
    this.decals = [];
    this.tracers = [];
    this.localCooldown = 0;
    input.reset(session.weapons.length);

    ensureTextures(this, [...CLASSES.map((c) => c.sprite), 'blood', 'box', 'grenade', 'acid', ...ENEMIES.map((e) => e.sprite)]);
    this.drawMap();
    this.tracerGfx = this.add.graphics().setDepth(5);
    this.fxGfx = this.add.graphics().setDepth(2.5);

    const map = session.map;
    const cam = this.cameras.main;
    cam.setBounds(0, 0, map.pixelWidth, map.pixelHeight);
    cam.setBackgroundColor('#0b0d0a');
    this.fitZoom();
    this.scale.on('resize', this.fitZoom, this);
    this.events.once('shutdown', () => this.scale.off('resize', this.fitZoom, this));

    const kb = this.input.keyboard!;
    this.keys = kb.addKeys('W,A,S,D,UP,DOWN,LEFT,RIGHT,R,Q,G,F,E,ONE,TWO,THREE') as Record<string, Phaser.Input.Keyboard.Key>;
    kb.on('keydown-G', () => (input.grenadeRequested = true));
    kb.on('keydown-F', () => (input.abilityRequested = true));
    kb.on('keydown-E', () => (input.abilityRequested = true));
    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      if (!p.wasTouch && p.rightButtonDown()) input.grenadeRequested = true;
    });
    kb.on('keydown-ONE', () => input.selectWeapon(0));
    kb.on('keydown-TWO', () => input.selectWeapon(1));
    kb.on('keydown-THREE', () => input.selectWeapon(2));
    kb.on('keydown-Q', () => input.cycleWeapon());
    kb.on('keydown-R', () => (input.reloadRequested = true));
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      if (!p.wasTouch) input.usingTouch = false;
    });
    this.input.on('wheel', (_p: unknown, _o: unknown, _dx: number, dy: number) => {
      if (dy > 0) input.cycleWeapon();
      else input.selectWeapon((input.weaponSlot + input.weaponCount - 1) % input.weaponCount);
    });
    this.input.mouse?.disableContextMenu();

    this.scene.launch('hud');
  }

  update(_time: number, delta: number): void {
    this.readKeyboard();
    this.acc = Math.min(this.acc + delta, 250);
    while (this.acc >= TICK_MS) {
      this.acc -= TICK_MS;
      this.fixedTick();
    }
    this.renderWorld(performance.now(), this.acc / TICK_MS, delta / 1000);
  }

  // ───────────── Entrada y simulación local ─────────────

  private readKeyboard(): void {
    const k = this.keys;
    const x = (k.D.isDown || k.RIGHT.isDown ? 1 : 0) - (k.A.isDown || k.LEFT.isDown ? 1 : 0);
    const y = (k.S.isDown || k.DOWN.isDown ? 1 : 0) - (k.W.isDown || k.UP.isDown ? 1 : 0);
    input.kbMove = { x, y };
    if (x !== 0 || y !== 0) input.usingTouch = false;
    const p = this.input.mousePointer;
    if (p && !input.usingTouch) {
      const world = this.cameras.main.getWorldPoint(p.x, p.y);
      input.mouseAim = Math.atan2(world.y - this.renderSelf.y, world.x - this.renderSelf.x);
      input.mouseFire = p.leftButtonDown();
      input.grenadeDist = Math.min(1, Math.hypot(world.x - this.renderSelf.x, world.y - this.renderSelf.y) / COMBAT.grenade.range);
    } else if (input.usingTouch) {
      input.grenadeDist = 1;
    }
  }

  private fixedTick(): void {
    if (!session.latest || !session.conn) return;
    const m = input.move();
    const cmd = session.sendInput({
      mx: round3(m.x),
      my: round3(m.y),
      a: round3(input.aim()),
      f: input.fire(),
      w: input.weaponSlot,
      r: input.consumeReload(),
      g: input.consumeGrenade(),
      gd: round3(input.grenadeDist),
      ab: input.consumeAbility(),
    });

    // Disparo cosmético inmediato (el daño real lo decide el servidor).
    this.localCooldown = Math.max(0, this.localCooldown - TICK_DT);
    const me = session.me();
    const w = session.weapons[cmd.w];
    if (cmd.f && me?.alive && !me.reloading && me.ammo > 0 && me.weapon === cmd.w && this.localCooldown <= 0 && w) {
      const ab = session.setup.ability;
      const rateMul = me.abilityActive && ab.id === 'adrenaline' ? 1 + ab.power : 1;
      this.localCooldown = 1 / (w.fireRate * rateMul);
      const r = session.setup.radius + 4;
      const ox = session.pred.x + Math.cos(cmd.a) * r;
      const oy = session.pred.y + Math.sin(cmd.a) * r;
      for (let i = 0; i < w.pellets; i++) {
        const a = cmd.a + (Math.random() - 0.5) * w.spread;
        const d = session.map.raycast(ox, oy, a, w.range);
        this.tracers.push({ x1: ox, y1: oy, x2: ox + Math.cos(a) * d, y2: oy + Math.sin(a) * d, life: TRACER_LIFE, mine: true });
      }
    }
  }

  // ───────────── Pintado ─────────────

  private renderWorld(now: number, alpha: number, dt: number): void {
    const view = session.interpolated(now);
    const me = session.me();

    // Jugador propio: posición predicha, suavizando la corrección.
    const decay = Math.exp(-dt / 0.08);
    session.predError.x *= decay;
    session.predError.y *= decay;
    this.renderSelf = {
      x: lerp(session.prevPred.x, session.pred.x, alpha) + session.predError.x,
      y: lerp(session.prevPred.y, session.pred.y, alpha) + session.predError.y,
    };

    const seen = new Set<number>();
    for (const p of view.players) {
      seen.add(p.id);
      const isMe = p.id === session.you;
      const pos = isMe && me?.alive ? this.renderSelf : p;
      const aim = isMe ? input.lastAim : p.aim;
      this.drawPlayer(p, pos.x, pos.y, aim, isMe ? (me?.alive ?? false) : p.alive);
    }
    this.drawPlayerFx(view.players, now, dt);
    for (const [id, v] of this.players) {
      if (seen.has(id)) continue;
      v.body.destroy();
      v.label.destroy();
      this.players.delete(id);
    }

    const zSeen = new Set<number>();
    for (const z of view.zombies) {
      zSeen.add(z.id);
      this.drawZombie(z, now);
    }
    for (const [id, img] of this.zombies) {
      if (zSeen.has(id)) continue;
      const last = this.lastZombiePos.get(id);
      if (last) this.addDecal(last.x, last.y, last.r / 14);
      img.destroy();
      this.zombies.delete(id);
      this.lastZombiePos.delete(id);
    }

    // Cajas de botín: aparecen y desaparecen con el último estado (no necesitan interpolación).
    const bSeen = new Set<number>();
    for (const b of session.latest?.boxes ?? []) {
      bSeen.add(b.id);
      let img = this.boxes.get(b.id);
      if (!img) {
        img = this.add.image(b.x, b.y, 'box').setDepth(2).setTint(hexColor(LOOT.boxes[b.tier]?.color ?? '#ffffff'));
        this.boxes.set(b.id, img);
      }
      const pulse = 1 + Math.sin(now / 180 + b.id) * 0.08;
      img.setScale(0.55 * pulse).setRotation(Math.sin(now / 500 + b.id) * 0.15);
    }
    for (const [id, img] of this.boxes) {
      if (bSeen.has(id)) continue;
      img.destroy();
      this.boxes.delete(id);
    }

    this.drawProjectiles(now);

    // Disparos de los demás (y sangre de todos los impactos), sincronizados con la interpolación.
    const rt = session.renderTick(now);
    const q = session.shotQueue;
    while (q.length && q[0].tick <= rt) {
      const { shot } = q.shift()!;
      if (shot.pid !== session.you) {
        this.tracers.push({ x1: shot.ox, y1: shot.oy, x2: shot.ex, y2: shot.ey, life: TRACER_LIFE, mine: false });
      }
      if (shot.hit && Math.random() < 0.35) this.addDecal(shot.ex, shot.ey, 0.35);
    }

    this.tracerGfx.clear();
    this.tracers = this.tracers.filter((t) => (t.life -= dt) > 0);
    for (const t of this.tracers) {
      const a = Math.max(0, t.life / TRACER_LIFE);
      this.tracerGfx.lineStyle(t.mine ? 2.5 : 2, 0xfff2a8, 0.9 * a).lineBetween(t.x1, t.y1, t.x2, t.y2);
    }

    // Cámara: al propio jugador (también en el suelo) o, si está muerto, a un compañero vivo.
    let focus = me?.alive ? this.renderSelf : me?.downed ? me : null;
    if (!focus) {
      const mate = view.players.find((p) => p.alive && p.id !== session.you);
      focus = mate ?? (me ? { x: me.x, y: me.y } : null);
    }
    if (focus) this.cameras.main.centerOn(focus.x, focus.y);
  }

  private drawPlayer(p: SnapPlayer, x: number, y: number, aim: number, alive: boolean): void {
    let v = this.players.get(p.id);
    if (!v) {
      const info = session.playerInfo(p.id);
      const color = PLAYER_COLORS[info?.color ?? 0];
      const cls = CLASSES[p.cls] ?? CLASSES[0];
      const key = cls.sprite;
      const body = this.add.image(x, y, key).setDepth(4).setTint(hexColor(color));
      body.setScale(spriteScale(this, key, cls.radius));
      const label = this.add
        .text(x, y, info?.name ?? `#${p.id}`, { fontFamily: 'system-ui, sans-serif', fontSize: '13px', color, stroke: '#000', strokeThickness: 3 })
        .setOrigin(0.5, 1)
        .setDepth(6);
      v = { body, label };
      this.players.set(p.id, v);
    }
    // En el suelo: semitransparente y tumbado; muerto: oculto.
    v.body.setVisible(alive || p.downed).setPosition(x, y).setRotation(p.downed ? aim + Math.PI / 2 : aim).setAlpha(p.downed ? 0.5 : 1);
    v.label.setVisible((alive && p.id !== session.you) || p.downed).setPosition(x, y - 20);
  }

  /** Anillo de reanimación de los caídos, auras de habilidad y explosiones/curaciones recientes. */
  private drawPlayerFx(players: SnapPlayer[], now: number, dt: number): void {
    const g = this.fxGfx;
    g.clear();
    for (const p of players) {
      const v = this.players.get(p.id);
      if (!v) continue;
      const { x, y } = v.body;
      if (p.downed) {
        const r = COMBAT.revive.radius;
        g.lineStyle(2, 0xef5350, 0.35 + 0.25 * Math.sin(now / 150)).strokeCircle(x, y, r);
        if (p.revive > 0) {
          g.lineStyle(5, 0x81c784, 0.9);
          g.beginPath();
          g.arc(x, y, 24, -Math.PI / 2, -Math.PI / 2 + (p.revive / 255) * Math.PI * 2);
          g.strokePath();
        }
      }
      if (p.abilityActive && p.alive) {
        const cls = CLASSES[p.cls];
        const color = cls?.ability.id === 'shield' ? 0x4fc3f7 : 0xffb74d;
        g.lineStyle(3, color, 0.6 + 0.2 * Math.sin(now / 90)).strokeCircle(x, y, 22);
      }
    }

    // Efectos nuevos de los snapshots (una vez por tick del servidor).
    const snap = session.latest;
    if (snap && snap.tick !== this.lastFxTick) {
      this.lastFxTick = snap.tick;
      for (const f of snap.fx) {
        const max = f.kind === FX_HEAL ? 0.6 : f.kind === FX_ACID ? 0.35 : 0.45;
        this.effects.push({ ...f, life: max, max });
        if (f.kind === FX_GRENADE || f.kind === FX_FIRE) this.addDecal(f.x, f.y, f.radius / 60, 0x222018);
        if (f.kind === FX_ACID) this.addDecal(f.x, f.y, 0.4, 0x4fc36f);
      }
    }
    this.effects = this.effects.filter((e) => (e.life -= dt) > 0);
    for (const e of this.effects) {
      const t = 1 - e.life / e.max;
      const a = e.life / e.max;
      if (e.kind === FX_HEAL) {
        g.lineStyle(4, 0x81c784, a).strokeCircle(e.x, e.y, e.radius * t);
      } else if (e.kind === FX_ACID) {
        g.fillStyle(0x7ee081, a * 0.7).fillCircle(e.x, e.y, e.radius * (0.5 + t));
      } else {
        const color = e.kind === FX_FIRE ? 0xff7043 : 0xffe082;
        g.fillStyle(color, a * 0.55).fillCircle(e.x, e.y, e.radius * (0.4 + 0.6 * t));
        g.lineStyle(3, 0xffffff, a * 0.6).strokeCircle(e.x, e.y, e.radius * (0.4 + 0.6 * t));
      }
    }
  }

  /** Granadas y ácido: como las cajas, se pintan en la última posición conocida. */
  private drawProjectiles(now: number): void {
    const seen = new Set<number>();
    for (const pr of session.latest?.projectiles ?? []) {
      seen.add(pr.id);
      let img = this.projectiles.get(pr.id);
      if (!img) {
        const grenade = pr.kind === PROJ_GRENADE;
        img = this.add.image(pr.x, pr.y, grenade ? 'grenade' : 'acid').setDepth(4.5).setScale(grenade ? 0.32 : 0.35);
        this.projectiles.set(pr.id, img);
      }
      // Suaviza el movimiento entre snapshots.
      img.setPosition(lerp(img.x, pr.x, 0.5), lerp(img.y, pr.y, 0.5));
      if (pr.kind === PROJ_GRENADE) img.setTint(Math.floor(now / 120) % 2 ? 0xffffff : 0xff5252);
    }
    for (const [id, img] of this.projectiles) {
      if (seen.has(id)) continue;
      img.destroy();
      this.projectiles.delete(id);
    }
  }

  private drawZombie(z: SnapZombie, now: number): void {
    const def = ENEMIES[z.type];
    let img = this.zombies.get(z.id);
    if (!img) {
      img = this.add.image(z.x, z.y, def.sprite).setDepth(def.boss ? 3.5 : 3);
      img.setScale(spriteScale(this, def.sprite, def.radius));
      this.zombies.set(z.id, img);
    }
    img.setPosition(z.x, z.y).setRotation(z.angle);
    if (z.flags & ZFLAG_WINDUP) img.setTint(Math.floor(now / 80) % 2 ? 0xffffff : hexColor(def.tint));
    else if (z.flags & ZFLAG_CHARGE) img.setTint(0xff5050);
    else if (z.flags & ZFLAG_ATTACK) img.setTint(Phaser.Display.Color.GetColor(255, 200, 200));
    else img.setTint(hexColor(def.tint));
    this.lastZombiePos.set(z.id, { x: z.x, y: z.y, r: def.radius });
  }

  private addDecal(x: number, y: number, scale: number, tint?: number): void {
    const d = this.add
      .image(x, y, 'blood')
      .setTint(tint ?? 0xffffff)
      .setDepth(1)
      .setRotation(Math.random() * Math.PI * 2)
      .setScale(scale * (0.8 + Math.random() * 0.4))
      .setAlpha(0.85);
    this.decals.push(d);
    if (this.decals.length > MAX_DECALS) this.decals.shift()!.destroy();
  }

  private drawMap(): void {
    const map = session.map;
    const ts = map.tileSize;
    const g = this.make.graphics({}, false);
    g.fillStyle(hexColor(map.def.floorColor ?? '#2b2f26')).fillRect(0, 0, map.pixelWidth, map.pixelHeight);
    g.lineStyle(1, 0xffffff, 0.04);
    for (let x = 0; x <= map.width; x++) g.lineBetween(x * ts, 0, x * ts, map.pixelHeight);
    for (let y = 0; y <= map.height; y++) g.lineBetween(0, y * ts, map.pixelWidth, y * ts);
    const wall = hexColor(map.def.wallColor ?? '#55524a');
    for (let ty = 0; ty < map.height; ty++) {
      for (let tx = 0; tx < map.width; tx++) {
        if (!map.isSolid(tx, ty)) continue;
        g.fillStyle(wall).fillRect(tx * ts, ty * ts, ts, ts);
        g.fillStyle(0xffffff, 0.08).fillRect(tx * ts, ty * ts, ts, 4);
        g.fillStyle(0x000000, 0.25).fillRect(tx * ts, ty * ts + ts - 4, ts, 4);
      }
    }
    for (const s of map.zombieSpawns) g.fillStyle(0x5a1a1a, 0.5).fillCircle(s.x, s.y, ts * 0.6);
    const rt = this.add.renderTexture(0, 0, map.pixelWidth, map.pixelHeight).setOrigin(0).setDepth(0);
    rt.draw(g);
    g.destroy();
  }

  private fitZoom(): void {
    const { width, height } = this.scale;
    this.cameras.main.setZoom(Math.max(0.45, Math.min(2, Math.min(width / 960, height / 600))));
  }
}
