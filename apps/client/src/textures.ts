import Phaser from 'phaser';

// Cualquier PNG en assets/sprites/<clave>.png sustituye al marcador dibujado con esa clave.
// Los sprites deben mirar hacia la derecha (ángulo 0). Ver README → "Cambiar el arte".
const pngs = import.meta.glob('../assets/sprites/*.png', { eager: true, query: '?url', import: 'default' }) as Record<
  string,
  string
>;

const PLACEHOLDER_SIZE = 64;

export function preloadSprites(scene: Phaser.Scene): void {
  for (const [path, url] of Object.entries(pngs)) {
    const key = path.split('/').pop()!.replace(/\.png$/, '');
    if (!scene.textures.exists(key)) scene.load.image(key, url);
  }
}

/** Escala para que el sprite ocupe ~1.2 veces el diámetro de colisión. */
export function spriteScale(scene: Phaser.Scene, key: string, radius: number): number {
  const frame = scene.textures.getFrame(key);
  const size = Math.max(frame?.width ?? PLACEHOLDER_SIZE, frame?.height ?? PLACEHOLDER_SIZE);
  return (radius * 2.4) / size;
}

/** Genera texturas de marcador (en blanco, se tiñen por datos) para las claves que no tengan PNG. */
export function ensureTextures(scene: Phaser.Scene, keys: string[]): void {
  for (const key of new Set(keys)) {
    if (scene.textures.exists(key)) continue;
    const g = scene.make.graphics({}, false);
    const c = PLACEHOLDER_SIZE / 2;
    if (key === 'player') {
      g.fillStyle(0x222222).fillRect(c + 8, c - 4, 26, 8);
      g.fillStyle(0xffffff).fillCircle(c, c, 24);
      g.lineStyle(3, 0x000000, 0.35).strokeCircle(c, c, 24);
      g.fillStyle(0x000000, 0.25).fillCircle(c + 4, c, 10);
    } else if (key === 'boss') {
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        g.fillStyle(0xffffff).fillTriangle(
          c + Math.cos(a - 0.25) * 22, c + Math.sin(a - 0.25) * 22,
          c + Math.cos(a + 0.25) * 22, c + Math.sin(a + 0.25) * 22,
          c + Math.cos(a) * 31, c + Math.sin(a) * 31,
        );
      }
      g.fillStyle(0xffffff).fillCircle(c, c, 24);
      g.fillStyle(0x000000, 0.4).fillCircle(c + 12, c - 8, 4).fillCircle(c + 12, c + 8, 4);
    } else if (key === 'box') {
      g.fillStyle(0xffffff).fillRoundedRect(c - 20, c - 20, 40, 40, 6);
      g.fillStyle(0x000000, 0.28).fillRect(c - 20, c - 4, 40, 8).fillRect(c - 4, c - 20, 8, 40);
      g.lineStyle(3, 0x000000, 0.45).strokeRoundedRect(c - 20, c - 20, 40, 40, 6);
    } else if (key === 'grenade') {
      g.fillStyle(0x3e4a2e).fillCircle(c, c, 18);
      g.fillStyle(0x222222).fillRect(c - 5, c - 26, 10, 10);
      g.lineStyle(3, 0x000000, 0.5).strokeCircle(c, c, 18);
    } else if (key === 'acid') {
      g.fillStyle(0x7ee081).fillCircle(c, c, 16);
      g.fillStyle(0xc8ffc0, 0.8).fillCircle(c - 5, c - 5, 6);
    } else if (key === 'blood') {
      g.fillStyle(0x7a0d0d, 0.85).fillCircle(c, c, 14);
      for (let i = 0; i < 7; i++) {
        const a = Math.random() * Math.PI * 2;
        const d = 10 + Math.random() * 14;
        g.fillCircle(c + Math.cos(a) * d, c + Math.sin(a) * d, 3 + Math.random() * 5);
      }
    } else {
      // Zombi genérico: cuerpo + brazos estirados hacia delante.
      g.fillStyle(0xffffff).fillRect(c + 6, c - 18, 20, 7).fillRect(c + 6, c + 11, 20, 7);
      g.fillStyle(0xffffff).fillCircle(c, c, 22);
      g.lineStyle(3, 0x000000, 0.3).strokeCircle(c, c, 22);
      g.fillStyle(0x000000, 0.35).fillCircle(c + 10, c - 6, 3).fillCircle(c + 10, c + 6, 3);
    }
    g.generateTexture(key, PLACEHOLDER_SIZE, PLACEHOLDER_SIZE);
    g.destroy();
  }
}

export function hexColor(s: string): number {
  return Phaser.Display.Color.HexStringToColor(s).color;
}
