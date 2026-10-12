import Phaser from 'phaser';
import './style.css';
import { setupNative } from './native';
import { GameScene } from './scenes/GameScene';
import { HudScene } from './scenes/HudScene';
import { initUI } from './ui';

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  backgroundColor: '#111410',
  scale: {
    mode: Phaser.Scale.RESIZE,
    width: window.innerWidth,
    height: window.innerHeight,
  },
  input: {
    activePointers: 4,
  },
  render: {
    antialias: true,
    powerPreference: 'high-performance',
  },
  scene: [],
});

game.scene.add('game', GameScene, false);
game.scene.add('hud', HudScene, false);

function startMatch(): void {
  // Reinicia ambas escenas con el estado nuevo de la partida.
  game.scene.stop('hud');
  game.scene.stop('game');
  game.scene.start('game');
}

initUI(startMatch);
void setupNative();
