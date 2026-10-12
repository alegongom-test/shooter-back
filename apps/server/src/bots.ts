// Clientes "bot" sin interfaz para probar salas llenas con un solo dispositivo.
// Cada bot usa su propia cuenta (bot1..bot4, se crea sola la primera vez) y gana botín como un jugador más.
// Uso:  npm run bots -- --code ABCD --count 3
//       npm run bots -- --count 4 --start        (crea sala, la empieza y juega solo)
//       opciones: --url ws://localhost:2567  --start-after 3
import { DEFAULT_PORT, MSG_SNAPSHOT, decodeSnapshot, type InputCmd, type ServerMsg, type Snapshot } from '@horda/shared';
import { WebSocket } from 'ws';

const args = process.argv.slice(2);
const opt = (name: string, def?: string) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : 'true';
};

const url = opt('url', `ws://localhost:${DEFAULT_PORT}`)!;
const count = Math.max(1, Math.min(4, Number(opt('count', '3'))));
const startAfter = Number(opt('start-after', '2'));
const autoStart = opt('start') === 'true';
const BOT_PASSWORD = 'bot-horda';
const BOT_CLASSES = ['assault', 'medic', 'heavy'];
let code = opt('code')?.toUpperCase();

class Bot {
  private ws: WebSocket;
  private you = 0;
  private seq = 0;
  private last: Snapshot | null = null;
  private wander = Math.random() * Math.PI * 2;
  private loop: NodeJS.Timeout | null = null;

  private triedRegister = false;

  constructor(readonly name: string, private readonly onWelcome?: (code: string) => void) {
    this.ws = new WebSocket(url);
    this.ws.on('open', () => this.send({ t: 'login', user: name, pass: BOT_PASSWORD }));
    this.ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const buf = data as Buffer;
        if (buf[0] === MSG_SNAPSHOT) this.last = decodeSnapshot(new Uint8Array(buf));
        return;
      }
      this.onMsg(JSON.parse(data.toString()) as ServerMsg);
    });
    this.ws.on('close', () => {
      if (this.loop) clearInterval(this.loop);
      console.log(`${name}: desconectado`);
    });
    this.ws.on('error', (e) => console.error(`${name}: ${e.message}`));
  }

  send(msg: object): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private onMsg(msg: ServerMsg): void {
    switch (msg.t) {
      case 'auth':
        // Cada bot con una clase distinta: bot1 asalto, bot2 médico, bot3 pesado…
        this.send({ t: 'setClass', cls: BOT_CLASSES[(Number(this.name.replace(/\D/g, '')) - 1) % BOT_CLASSES.length] });
        if (code) this.send({ t: 'join', code });
        else this.send({ t: 'create' });
        break;
      case 'rewards':
        console.log(`${this.name}: +${msg.rewards.xp} XP, +${msg.rewards.cash} $, ${msg.rewards.items.length} armas nuevas`);
        break;
      case 'welcome':
        this.you = msg.you;
        console.log(`${this.name}: dentro de la sala ${msg.code}`);
        this.onWelcome?.(msg.code);
        break;
      case 'start':
        if (msg.setup) console.log(`${this.name}: juega como ${msg.setup.classId} (vida ${msg.setup.maxHp}, ${msg.setup.grenades} granadas, armadura ${msg.setup.armorName})`);
        this.last = null;
        if (!this.loop) this.loop = setInterval(() => this.think(), 50);
        break;
      case 'end':
        console.log(`${this.name}: fin de partida → ${msg.stats.result} (${msg.stats.kills} bajas, ${msg.stats.elapsed}s)`);
        if (this.loop) clearInterval(this.loop);
        this.loop = null;
        if (autoStart) setTimeout(() => process.exit(0), 1500);
        break;
      case 'err':
        if (msg.ctx === 'auth' && !this.triedRegister) {
          this.triedRegister = true;
          this.send({ t: 'register', user: this.name, pass: BOT_PASSWORD });
          break;
        }
        console.error(`${this.name}: ${msg.msg}`);
        break;
      default:
        break;
    }
  }

  /** Apunta al zombi más cercano y se aleja de él si está muy cerca; si no, deambula. */
  private think(): void {
    const me = this.last?.players.find((p) => p.id === this.you);
    let mx = Math.cos(this.wander);
    let my = Math.sin(this.wander);
    let a = this.wander;
    let f = false;
    if (Math.random() < 0.03) this.wander += (Math.random() - 0.5) * 2;
    let g = false;
    let ab = false;
    if (me && this.last) {
      let best = Infinity;
      for (const z of this.last.zombies) {
        const d = Math.hypot(z.x - me.x, z.y - me.y);
        if (d < best) {
          best = d;
          a = Math.atan2(z.y - me.y, z.x - me.x);
        }
      }
      f = best < 450;
      if (best < 140) {
        mx = -Math.cos(a);
        my = -Math.sin(a);
      } else if (best < 450) {
        mx *= 0.3;
        my *= 0.3;
      }
      // Granada si hay un grupo de zombis delante; habilidad cuando hay peligro.
      const close = this.last.zombies.filter((z) => Math.hypot(z.x - me.x, z.y - me.y) < 300).length;
      g = close >= 8 && me.grenades > 0 && Math.random() < 0.1;
      ab = close >= 5 && me.abilityCd === 0;
      // Revivir: ir hacia el compañero caído más cercano.
      const downed = this.last.players.filter((p) => p.downed);
      if (downed.length) {
        const d = downed.reduce((b, p) => (Math.hypot(p.x - me.x, p.y - me.y) < Math.hypot(b.x - me.x, b.y - me.y) ? p : b));
        const dist = Math.hypot(d.x - me.x, d.y - me.y);
        mx = dist > 30 ? (d.x - me.x) / dist : 0;
        my = dist > 30 ? (d.y - me.y) / dist : 0;
      }
    }
    const cmd: InputCmd = { s: ++this.seq, mx: +mx.toFixed(3), my: +my.toFixed(3), a, f, w: 1, r: false, g, gd: 0.8, ab };
    this.send({ t: 'i', ...cmd });
  }
}

const bots: Bot[] = [];
const spawnRest = () => {
  for (let i = bots.length; i < count; i++) bots.push(new Bot(`bot${i + 1}`));
};

if (code) {
  spawnRest();
} else {
  bots.push(
    new Bot('bot1', (c) => {
      if (code) return;
      code = c;
      console.log(`\nSala creada: ${c}  (únete desde el juego con este código)\n`);
      spawnRest();
      if (autoStart) setTimeout(() => bots[0].send({ t: 'start' }), startAfter * 1000);
    }),
  );
}
