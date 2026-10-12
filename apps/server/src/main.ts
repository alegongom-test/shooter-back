import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { DEFAULT_MODE, DEFAULT_PORT, type ClientMsg } from '@horda/shared';
import { WebSocketServer } from 'ws';
import { AccountError, accounts } from './accounts';
import { createRoom, findRoom, log, roomCount, send, type Client } from './room';

const PORT = Number(process.env.PORT) || DEFAULT_PORT;
/** Intentos de login fallidos por conexión antes de cortarla. */
const MAX_AUTH_FAILURES = 5;

const http = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: roomCount() }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Servidor de Horda funcionando. Conéctate por WebSocket.\n');
});

const wss = new WebSocketServer({ server: http, maxPayload: 4096 });

wss.on('connection', (ws) => {
  ws.binaryType = 'nodebuffer';
  const client: Client = { ws, room: null, playerId: 0, userId: 0, username: '', token: '' };
  let authFailures = 0;

  const authenticated = (token: string, userId: number) => {
    client.userId = userId;
    client.token = token;
    client.username = accounts.username(userId);
    send(client, { t: 'auth', token, profile: accounts.profile(userId) });
    log(`sesión iniciada: ${client.username}`);
  };

  const authFailed = (e: unknown) => {
    authFailures++;
    send(client, { t: 'err', ctx: 'auth', msg: e instanceof AccountError ? e.message : 'Error al iniciar sesión' });
    if (!(e instanceof AccountError)) log(`error de autenticación: ${(e as Error).message}`);
    if (authFailures >= MAX_AUTH_FAILURES) ws.close();
  };

  const sendProfile = () => send(client, { t: 'profile', profile: accounts.profile(client.userId) });

  ws.on('message', async (data, isBinary) => {
    if (isBinary) return;
    let msg: ClientMsg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    const str = (v: unknown) => (typeof v === 'string' ? v : '');

    try {
      switch (msg.t) {
        case 'ping':
          send(client, { t: 'pong', c: msg.c });
          return;
        case 'register': {
          const r = await accounts.register(str(msg.user), str(msg.pass));
          log(`cuenta creada: ${str(msg.user)}`);
          authenticated(r.token, r.userId);
          return;
        }
        case 'login': {
          const r = await accounts.login(str(msg.user), str(msg.pass));
          authenticated(r.token, r.userId);
          return;
        }
        case 'resume':
          authenticated(str(msg.token), accounts.resume(str(msg.token)));
          return;
        default:
          break;
      }
    } catch (e) {
      authFailed(e);
      return;
    }

    // A partir de aquí hace falta haber iniciado sesión.
    if (!client.userId) {
      send(client, { t: 'err', ctx: 'auth', msg: 'Inicia sesión primero' });
      return;
    }

    try {
      switch (msg.t) {
        case 'logout':
          client.room?.leave(client);
          accounts.logout(client.token);
          Object.assign(client, { userId: 0, username: '', token: '' });
          send(client, { t: 'loggedOut' });
          return;
        case 'equip':
          accounts.equip(client.userId, Number(msg.slot), Number(msg.item));
          sendProfile();
          return;
        case 'upgrade':
          accounts.upgrade(client.userId, Number(msg.item));
          sendProfile();
          return;
        case 'sell':
          accounts.sell(client.userId, Number(msg.item));
          sendProfile();
          return;
        case 'setClass':
          accounts.setClass(client.userId, str(msg.cls));
          sendProfile();
          client.room?.refresh(client);
          return;
        case 'skill':
          accounts.learnSkill(client.userId, str(msg.cls), str(msg.skill));
          sendProfile();
          return;
        case 'resetSkills':
          accounts.resetSkills(client.userId, str(msg.cls));
          sendProfile();
          return;
        case 'leave':
          client.room?.leave(client);
          return;
        case 'create':
          if (client.room) client.room.leave(client);
          createRoom(DEFAULT_MODE).join(client);
          return;
        case 'join': {
          if (client.room) client.room.leave(client);
          const room = findRoom(str(msg.code));
          if (!room) send(client, { t: 'err', msg: 'No existe ninguna sala con ese código' });
          else room.join(client);
          return;
        }
        default:
          client.room?.handle(client, msg);
      }
    } catch (e) {
      if (e instanceof AccountError) send(client, { t: 'err', msg: e.message });
      else {
        log(`error procesando '${msg.t}': ${(e as Error).message}`);
        send(client, { t: 'err', msg: 'Error del servidor' });
      }
    }
  });

  ws.on('close', () => client.room?.leave(client));
  ws.on('error', () => ws.close());
});

http.listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i!.address);
  log(`Servidor de juego escuchando en el puerto ${PORT}`);
  log(`  En este PC:        ws://localhost:${PORT}`);
  for (const ip of ips) log(`  En tu red local:   ws://${ip}:${PORT}`);
  if (Number(process.env.HORDA_SURVIVE_SECONDS) > 0) log(`  (modo prueba: jefe a los ${process.env.HORDA_SURVIVE_SECONDS}s)`);
});
