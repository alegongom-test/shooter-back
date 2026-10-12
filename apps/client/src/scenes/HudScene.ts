import Phaser from 'phaser';
import { ENEMIES, LOOT, PHASE, rarityDef } from '@horda/shared';
import { input } from '../input';
import { tryWebFullscreen } from '../native';
import { session } from '../session';

const STICK_RADIUS = 64;
const AIM_DEADZONE = 0.25;
const FONT = 'system-ui, -apple-system, sans-serif';

interface Stick {
  id: number;
  bx: number;
  by: number;
  x: number;
  y: number;
}

interface Button {
  x: number;
  y: number;
  r: number;
  label: () => string;
  action: () => void;
}

/** Interfaz por encima del mundo (sin zoom de cámara) y controles táctiles. */
export class HudScene extends Phaser.Scene {
  private gfx!: Phaser.GameObjects.Graphics;
  private timerText!: Phaser.GameObjects.Text;
  private killsText!: Phaser.GameObjects.Text;
  private hpText!: Phaser.GameObjects.Text;
  private weaponText!: Phaser.GameObjects.Text;
  private centerText!: Phaser.GameObjects.Text;
  private debugText!: Phaser.GameObjects.Text;
  private boxText!: Phaser.GameObjects.Text;
  private gearText!: Phaser.GameObjects.Text;
  private alertText!: Phaser.GameObjects.Text;
  private toastText!: Phaser.GameObjects.Text;
  private toastUntil = 0;
  private lastCollected: number[] = [];
  private buttonTexts: Phaser.GameObjects.Text[] = [];
  private moveStick: Stick | null = null;
  private aimStick: Stick | null = null;
  private buttons: Button[] = [];

  constructor() {
    super('hud');
  }

  create(): void {
    const style = (size: number, color = '#e8eadf'): Phaser.Types.GameObjects.Text.TextStyle => ({
      fontFamily: FONT,
      fontSize: `${size}px`,
      color,
      stroke: '#000',
      strokeThickness: 4,
    });
    this.moveStick = null;
    this.aimStick = null;
    this.gfx = this.add.graphics();
    this.timerText = this.add.text(0, 10, '', style(24)).setOrigin(0.5, 0);
    this.killsText = this.add.text(0, 40, '', style(14, '#c9e265')).setOrigin(0.5, 0);
    this.hpText = this.add.text(16, 14, '', style(14));
    this.weaponText = this.add.text(16, 48, '', style(16));
    this.centerText = this.add.text(0, 0, '', { ...style(26), align: 'center' }).setOrigin(0.5);
    this.debugText = this.add.text(0, 0, '', style(11, '#9aa38c')).setOrigin(0, 1);
    this.gearText = this.add.text(16, 72, '', style(14));
    this.boxText = this.add.text(16, 94, '', style(14, '#ffd54f'));
    this.alertText = this.add.text(0, 0, '', style(16, '#ef9a9a')).setOrigin(0.5, 0);
    this.toastText = this.add.text(0, 0, '', style(20)).setOrigin(0.5);
    this.lastCollected = [];
    this.toastUntil = 0;

    this.buttons = [
      { x: 0, y: 0, r: 34, label: () => 'ARMA', action: () => input.cycleWeapon() },
      { x: 0, y: 0, r: 28, label: () => 'R', action: () => (input.reloadRequested = true) },
      { x: 0, y: 0, r: 30, label: () => `GRAN.\n${session.me()?.grenades ?? 0}`, action: () => (input.grenadeRequested = true) },
      {
        x: 0,
        y: 0,
        r: 34,
        label: () => {
          const cd = session.me()?.abilityCd ?? 0;
          return cd > 0 ? `${cd}s` : 'HAB.';
        },
        action: () => (input.abilityRequested = true),
      },
    ];
    this.buttonTexts = this.buttons.map(() => this.add.text(0, 0, '', style(13)).setOrigin(0.5).setVisible(false));
    this.layout();
    this.scale.on('resize', this.layout, this);
    this.events.once('shutdown', () => this.scale.off('resize', this.layout, this));

    this.input.on('pointerdown', this.onDown, this);
    this.input.on('pointermove', this.onMove, this);
    this.input.on('pointerup', this.onUp, this);
    this.input.on('pointerupoutside', this.onUp, this);
  }

  private layout(): void {
    const { width, height } = this.scale;
    this.timerText.setX(width / 2);
    this.killsText.setX(width / 2);
    this.centerText.setPosition(width / 2, height * 0.38);
    this.toastText.setPosition(width / 2, height * 0.22);
    this.debugText.setPosition(8, height - 6);
    this.buttons[0].x = width - 54;
    this.buttons[0].y = height * 0.3;
    this.buttons[1].x = width - 132;
    this.buttons[1].y = height * 0.3 - 18;
    // Granada junto al joystick derecho y habilidad bajo el botón de arma.
    this.buttons[2].x = width - 200;
    this.buttons[2].y = height - 70;
    this.buttons[3].x = width - 54;
    this.buttons[3].y = height * 0.3 + 76;
    this.alertText.setPosition(width / 2, 84);
  }

  // ───────────── Táctil ─────────────

  private onDown(p: Phaser.Input.Pointer): void {
    if (!p.wasTouch) return;
    input.usingTouch = true;
    tryWebFullscreen();
    for (const b of this.buttons) {
      if (Math.hypot(p.x - b.x, p.y - b.y) <= b.r + 8) {
        b.action();
        return;
      }
    }
    const stick: Stick = { id: p.id, bx: p.x, by: p.y, x: p.x, y: p.y };
    if (p.x < this.scale.width / 2) {
      if (!this.moveStick) this.moveStick = stick;
    } else if (!this.aimStick) {
      this.aimStick = stick;
    }
  }

  private onMove(p: Phaser.Input.Pointer): void {
    for (const s of [this.moveStick, this.aimStick]) {
      if (s && s.id === p.id) {
        s.x = p.x;
        s.y = p.y;
      }
    }
    this.applySticks();
  }

  private onUp(p: Phaser.Input.Pointer): void {
    if (this.moveStick?.id === p.id) this.moveStick = null;
    if (this.aimStick?.id === p.id) this.aimStick = null;
    this.applySticks();
  }

  private stickVec(s: Stick | null): { x: number; y: number; len: number } {
    if (!s) return { x: 0, y: 0, len: 0 };
    let dx = (s.x - s.bx) / STICK_RADIUS;
    let dy = (s.y - s.by) / STICK_RADIUS;
    const len = Math.hypot(dx, dy);
    if (len > 1) {
      dx /= len;
      dy /= len;
    }
    return { x: dx, y: dy, len: Math.min(1, len) };
  }

  private applySticks(): void {
    const m = this.stickVec(this.moveStick);
    input.touchMove = m.len < 0.12 ? { x: 0, y: 0 } : { x: m.x, y: m.y };
    const a = this.stickVec(this.aimStick);
    if (a.len >= AIM_DEADZONE) {
      input.touchAim = Math.atan2(a.y, a.x);
      input.touchFire = true;
    } else {
      input.touchAim = null;
      input.touchFire = false;
    }
  }

  // ───────────── Pintado ─────────────

  update(): void {
    const g = this.gfx;
    g.clear();
    const { width, height } = this.scale;
    const snap = session.latest;
    const me = session.me();

    if (snap) {
      const elapsed = snap.elapsedMs / 1000;
      if (snap.phase === PHASE.playing) {
        const left = Math.max(0, Math.ceil(session.mode.surviveSeconds - elapsed));
        this.timerText.setText(`SOBREVIVE  ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`).setColor('#e8eadf');
      } else if (snap.phase === PHASE.boss) {
        this.timerText.setText(`¡${ENEMIES.find((e) => e.boss)?.name.toUpperCase() ?? 'JEFE'}!`).setColor('#ce93d8');
        const boss = snap.zombies.find((z) => ENEMIES[z.type].boss);
        if (boss) {
          const bw = Math.min(360, width * 0.5);
          g.fillStyle(0x000000, 0.6).fillRect(width / 2 - bw / 2 - 2, 42, bw + 4, 14);
          g.fillStyle(0x8e44ad).fillRect(width / 2 - bw / 2, 44, (bw * boss.hp) / 255, 10);
        }
      } else {
        this.timerText.setText(snap.phase === PHASE.victory ? '¡VICTORIA!' : 'DERROTA');
      }
      this.killsText.setText(`Bajas: ${snap.kills}`).setY(snap.phase === PHASE.boss ? 60 : 40);
      this.updateBoxes(snap.collected);
    } else {
      this.timerText.setText('Conectando…');
      this.killsText.setText('');
    }

    if (me) {
      const hp = me.hp / 255;
      g.fillStyle(0x000000, 0.6).fillRect(14, 32, 164, 10);
      g.fillStyle(hp > 0.5 ? 0x81c784 : hp > 0.25 ? 0xffb74d : 0xef5350).fillRect(16, 34, 160 * hp, 6);
      this.hpText.setText(`Vida ${Math.ceil(hp * 100)}`);
      const w = session.weapons[input.weaponSlot];
      const ammo = me.weapon !== input.weaponSlot ? '…' : me.reloading ? 'RECARGANDO' : `${me.ammo}/${w.magSize}`;
      const item = session.loadoutItems[input.weaponSlot];
      this.weaponText.setText(`${input.weaponSlot + 1}. ${w.name}   ${ammo}`).setColor(item ? rarityDef(item.rarity).color : '#e8eadf');
      if (me.downed) {
        this.centerText.setText(`¡En el suelo!\nUn compañero puede revivirte · ${me.bleed}s`);
      } else if (!me.alive) {
        this.centerText.setText(me.respawn > 0 && me.respawn < 255 ? `Has caído\nReapareces en ${me.respawn}s` : 'Has caído');
      } else this.centerText.setText('');

      const ab = session.setup.ability;
      const abState = me.abilityActive ? 'ACTIVA' : me.abilityCd > 0 ? `${me.abilityCd}s` : 'LISTA (F)';
      this.gearText
        .setText(`Granadas ${me.grenades} (G)   ${ab.name}: ${abState}`)
        .setColor(me.abilityCd === 0 ? '#c9e265' : '#e8eadf');

      // Aviso de compañeros caídos.
      const downed = snap?.players.filter((p) => p.downed && p.id !== session.you) ?? [];
      this.alertText.setText(
        downed.map((p) => `¡${session.playerInfo(p.id)?.name ?? `#${p.id}`} está en el suelo! (${p.bleed}s)`).join('\n'),
      );
    }

    const fps = Math.round(this.game.loop.actualFps);
    this.debugText.setText(
      `FPS ${fps} · ping ${session.ping} ms · zombis ${snap?.zombies.length ?? 0} · tick ${snap?.tick ?? 0} · sala ${session.code}`,
    );

    this.drawTouch(g, width, height);
  }

  /** Contador de cajas del equipo y aviso cuando se recoge una nueva. */
  private updateBoxes(collected: number[]): void {
    const total = collected.reduce((a, b) => a + b, 0);
    this.boxText.setText(total ? `Cajas: ${total}` : '');
    collected.forEach((n, tier) => {
      if (n > (this.lastCollected[tier] ?? 0)) {
        const box = LOOT.boxes[tier];
        this.toastText.setText(`+ Caja de ${box.name}`).setColor(box.color).setAlpha(1);
        this.toastUntil = performance.now() + 1800;
      }
    });
    this.lastCollected = [...collected];
    const left = this.toastUntil - performance.now();
    this.toastText.setAlpha(left > 0 ? Math.min(1, left / 400) : 0);
  }

  private drawTouch(g: Phaser.GameObjects.Graphics, width: number, height: number): void {
    const show = input.usingTouch;
    this.buttonTexts.forEach((t, i) => {
      const b = this.buttons[i];
      t.setVisible(show).setPosition(b.x, b.y).setText(b.label()).setAlign('center');
    });
    if (!show) return;
    for (const b of this.buttons) {
      g.fillStyle(0x000000, 0.35).fillCircle(b.x, b.y, b.r);
      g.lineStyle(2, 0xffffff, 0.35).strokeCircle(b.x, b.y, b.r);
    }
    const drawStick = (s: Stick | null, hx: number, hy: number, color: number) => {
      const bx = s?.bx ?? hx;
      const by = s?.by ?? hy;
      g.lineStyle(2, 0xffffff, s ? 0.4 : 0.15).strokeCircle(bx, by, STICK_RADIUS);
      const v = this.stickVec(s);
      g.fillStyle(color, s ? 0.55 : 0.2).fillCircle(bx + v.x * STICK_RADIUS, by + v.y * STICK_RADIUS, 26);
    };
    drawStick(this.moveStick, 110, height - 110, 0xffffff);
    drawStick(this.aimStick, width - 110, height - 110, 0xef5350);
  }
}
