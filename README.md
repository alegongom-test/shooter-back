# Horda: PoC de shooter cooperativo de zombis

Prueba de concepto (fases 0, 1 y 2) de un juego cooperativo de zombis con vista cenital, inspirado en SAS 4. El análisis completo está en [`../ANALISIS.md`](../ANALISIS.md).

**Modo de juego:** un mapa. Durante 5 minutos llegan zombis cada vez más rápido; después aparece **El Carnicero**, el jefe.
- **Victoria:** matar al jefe.
- **Derrota:** que todos los jugadores caigan a la vez.
- **Jugadores:** de 1 a 4 por sala.
- **Reaparición:** un jugador caído vuelve a los 10 s junto a un compañero vivo.

**Progresión (fase 1):**
- **Cuentas:** usuario y contraseña, guardadas en SQLite en el propio servidor.
- **Cajas:** los zombis sueltan cajas de bronce, plata, oro o titanio. Las recoge cualquier jugador pasando por encima y cuentan para todo el equipo: cada jugador recibe todas las cajas recogidas. La caja del jefe va directa al equipo.
- **Al terminar la partida**, se abren las cajas y cada jugador recibe armas con rareza (común → legendaria), además de XP y dinero según sus bajas, el tiempo y el resultado.
- **Arsenal:** equipar 1 arma corta y 2 principales, mejorar armas con dinero (+7 % de daño por nivel, hasta +10) y vender las que sobren.
- **Nivel:** cada nivel da +2 de vida máxima y desbloquea armas y armaduras nuevas en las cajas.

**Clases y combate (fase 2):**
- **Clases:** se elige en el inicio o en la sala de espera.
  - **Asalto:** Adrenalina, más cadencia y velocidad durante 6 s.
  - **Médico:** Pulso curativo en área, y revive el doble de rápido.
  - **Pesado:** más vida, más granadas y un Escudo que reduce el daño un 60 % durante 6 s.
- **Habilidades:** cada clase tiene su árbol, con 1 punto por nivel y 3 niveles de árbol que se desbloquean gastando puntos. Se pueden reiniciar gratis. La pantalla *Habilidades* muestra el resumen de combate resultante.
- **Tipos de daño:** físico, fuego y tóxico. Las armaduras (Chaleco, Kevlar, Traje NBQ, Traje ignífugo, Coraza pesada) resisten cada tipo de forma distinta y ocupan una cuarta ranura de equipo.
- **Enemigos nuevos:**
  - **Escupidor:** se queda a distancia y lanza ácido (daño tóxico).
  - **Hinchado:** explota al acercarse (daño de fuego). Si lo revientas a tiros, la explosión arrasa a los zombis de alrededor.
- **Caer y revivir:** si caes y hay compañeros en pie, tienes 20 s en el suelo. Un compañero que se quede a tu lado te levanta en 3 s (el médico, más rápido). Si nadie llega, mueres y reapareces a los 10 s. La partida se pierde cuando no queda nadie en pie.
- **Granadas:** según la clase y las habilidades, se recupera una cada 40 s.

## Estructura

```
shooter/
  apps/client/      Phaser 3 + Vite + Capacitor (android/)
  apps/server/      servidor de salas autoritativo (Node + ws)
  packages/shared/  mapa, colisiones, movimiento, protocolo binario, tipos
  data/             contenido del juego en JSON (armas, enemigos, clase, modos, mapas)
  scripts/          utilidades (firewall de Windows)
```

## Requisitos

- Node 22 o superior (probado con Node 24).
- Para generar la APK: Android Studio (SDK) y JDK 21.

```bash
npm install
```

## Arrancar en local

```bash
npm run dev        # servidor (:2567) + cliente web (:5173), ambos con recarga en caliente
npm run dev:boss   # igual, pero el jefe aparece a los 30 s (para probar rápido)
```

Abre `http://localhost:5173`, crea una cuenta, pulsa **Crear sala** y luego **Empezar partida**. La sesión queda guardada: la próxima vez aparece **Continuar como …**.

Atajo para desarrollo: `http://localhost:5173/?auto=1` entra con la cuenta `tester` (la crea si no existe), crea una sala y empieza la partida solo. Para otra cuenta: `?auto=1&user=pepe&pass=1234`.

**Datos guardados:** la base de datos está en `apps/server/data/horda.db` (se puede cambiar con `HORDA_DB`). Para empezar de cero, para el servidor y borra esa carpeta.

**Controles en PC:**
- **WASD / flechas:** moverse.
- **Ratón:** apuntar.
- **Clic izquierdo:** disparar.
- **1/2/3, Q o rueda del ratón:** cambiar de arma.
- **R:** recargar.
- **G o clic derecho:** granada; cae donde está el cursor.
- **F o E:** habilidad de clase.

**Controles en móvil:**
- **Joystick izquierdo:** moverse.
- **Joystick derecho:** apuntar y disparar.
- **ARMA / R:** cambiar de arma y recargar.
- **GRAN.:** granada, lanzada al máximo alcance.
- **HAB.:** habilidad de clase.

## Probar con 2 PCs y 2 móviles en la misma Wi-Fi

Uno de los PCs hace de anfitrión (PC-1):

1. **Abrir el firewall (una sola vez).** En PC-1, abre PowerShell **como administrador** y ejecuta:
   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\abrir-firewall.ps1
   ```
   La Wi-Fi tiene que estar marcada como red **privada** en Windows. El script también muestra la IP del PC, por ejemplo `192.168.1.134`.
2. **Arrancar el juego en PC-1:** `npm run dev`. La consola también muestra las direcciones de red.
3. **PC-2:** abre en el navegador `http://192.168.1.134:5173`. El campo *Servidor* ya viene relleno.
4. **Móviles, sin instalar nada (Android o iPhone):** abre en Chrome o Safari `http://192.168.1.134:5173`. Al primer toque se pasa a pantalla completa.
5. **Móviles con la app de Android:** instala la APK (ver abajo) y en *Servidor* escribe `192.168.1.134`. Se guarda para la próxima vez.
6. **Cuentas:** cada jugador crea su cuenta. Todas se guardan en el servidor de PC-1.
7. **Entrar en la misma partida:** un jugador pulsa **Crear sala** y el resto escribe el código de 4 letras y pulsa **Unirse**.

¿Te falta gente? `npm run bots -- --code ABCD --count 3` mete 3 bots en la sala `ABCD`. Los bots se mueven y disparan solos, usan las cuentas `bot1`…`bot4` (se crean solas) y también ganan botín.

Aviso: en la red local la contraseña viaja sin cifrar (`ws://`). Con el túnel de Cloudflare (`wss://`) va cifrada. No uses una contraseña que uses en otros sitios.

## Probar desde redes distintas (amigos en su casa, datos móviles)

Usa un túnel gratuito de Cloudflare. No necesita cuenta. Descarga `cloudflared` desde https://github.com/cloudflare/cloudflared/releases y ejecuta:

```bash
cloudflared tunnel --url http://localhost:2567
```

El comando muestra una URL `https://xxxx.trycloudflare.com`. Los demás escriben esa URL en *Servidor* (el juego la convierte a `wss://` solo). Para quien juegue desde el navegador, también se puede tunelizar el `5173` o publicar el cliente en Vercel (`npm run build` → carpeta `apps/client/dist`).

## APK de Android

```bash
npm run apk
# → apps/client/android/app/build/outputs/apk/debug/app-debug.apk
```

Para instalarla:
- **Opción 1:** pasa el archivo al móvil (por cable, Drive, etc.) y ábrelo. Hay que permitir "instalar apps de origen desconocido".
- **Opción 2:** con el móvil conectado por USB y la depuración USB activada, ejecuta `npm run android` para compilarla, instalarla y abrirla.

Sobre la configuración de Android:
- **Conexión al servidor:** la app se sirve como `http://localhost` y tiene `usesCleartextTraffic` activado, así que puede conectar a `ws://` en la red local. Para producción con `wss://` se puede volver a `https` en `capacitor.config.ts`.
- **Pantalla:** la app va en horizontal, sin barra de estado y sin que se apague la pantalla.

## Opciones de prueba

**Lag y jitter simulados:** en el menú, *Opciones de prueba*, o por URL (`?lag=150&jitter=20`). Añaden latencia a la conexión para ver cómo se comporta la red sin salir de la Wi-Fi.

**Información en pantalla:** la línea inferior muestra FPS, ping, número de zombis, tick del servidor y código de sala.

**Bots:**

| Comando | Qué hace |
|---|---|
| `npm run bots -- --code ABCD --count 3` | 3 bots se unen a la sala `ABCD` |
| `npm run bots -- --count 4 --start` | Crean sala, empiezan y juegan solos hasta el final |
| `--url ws://192.168.1.134:2567` | Para conectar los bots a otro servidor |

**Variables del servidor:**
- `PORT`: puerto, por defecto `2567`.
- `HORDA_SURVIVE_SECONDS`: segundos hasta que sale el jefe.
- `HORDA_DB`: ruta del archivo SQLite.

## Cambiar el contenido (sin tocar código)

| Quiero… | Edito… |
|---|---|
| Ajustar daño, cadencia o cargador de un arma, su ranura o el nivel en que aparece | `data/weapons.json` |
| Cambiar vida, velocidad, color, XP, dinero o probabilidad de caja de un zombi | `data/enemies.json` (el orden importa: es el id que viaja por red) |
| Rarezas, contenido de cada caja, coste de mejoras, curva de niveles, recompensas | `data/loot.json` (el orden de `boxes` importa) |
| Clases: vida, velocidad, granadas, habilidad | `data/classes.json` |
| Árboles de habilidades | `data/skills.json` (cada habilidad modifica una estadística: `damage`, `fireRate`, `reload`, `mag`, `hp`, `speed`, `armor`, `grenades`, `grenadeDamage`, `abilityCooldown`, `abilityPower`, `reviveSpeed`) |
| Armaduras y sus resistencias | `data/armors.json` |
| Granadas, tiempo en el suelo, reanimación, tope de resistencia | `data/combat.json` |
| Cambiar la duración, la curva de zombis o la mezcla de tipos | `data/modes/survive_boss.json` |
| Cambiar el mapa | `data/maps/arena.json`: `#` muro, `.` suelo, `P` aparición de jugadores, `Z` aparición de zombis |
| Añadir un mapa o un modo nuevo | Crea el JSON y regístralo en `packages/shared/src/data.ts` |

## Cambiar el arte

Cada entidad tiene una clave de sprite en los datos: `player`, `zombie`, `boss`, `blood`, `box`, `grenade`, `acid`.
- **Sin PNG:** si no hay imagen para una clave, el juego dibuja un marcador blanco y lo tiñe con el color (`tint`) de los datos.
- **Con PNG:** para usar arte real, copia un PNG a `apps/client/assets/sprites/<clave>.png`. No hace falta tocar código.
- **Formato del PNG:** el sprite tiene que mirar hacia la **derecha**. Se escala solo según el radio de colisión.
- **Arte gratuito recomendado:** el pack CC0 *Top-down Shooter* de Kenney (https://kenney.nl/assets/top-down-shooter).

## Cómo funciona la red

- **El servidor manda:** simula a 20 ticks por segundo y decide impactos, daño y muertes. Los clientes solo envían su input (movimiento, apuntado, disparo, arma).
- **Tu movimiento se ve al instante:** el cliente aplica tu movimiento sin esperar al servidor, con la misma función `applyMovement` del paquete compartido. Cuando llega el estado del servidor, el cliente vuelve a aplicar los inputs que el servidor aún no ha confirmado y suaviza la diferencia.
- **Los demás se ven con 100 ms de retraso:** el resto de jugadores y los zombis se interpolan entre dos estados del servidor.
- **Formato de los mensajes:**
  - **Estado de la partida:** mensaje binario (`packages/shared/src/protocol.ts`). Ocupa unos 1,9 KB con 180 zombis, unos 37 KB/s por jugador.
  - **Control** (salas, inputs, ping): JSON.
- **Coste en el servidor:** un tick con 4 jugadores y 180 zombis tarda unos 0,2 ms, de un presupuesto de 50 ms.
- **Equipo de combate:** al empezar la partida, el servidor calcula el equipo efectivo de cada jugador (clase + nivel + habilidades + objetos) con `buildCombatSetup`, de `packages/shared/src/progression.ts`, y se lo envía. El cliente lo usa para predecir el movimiento y el disparo, y la pantalla de habilidades usa la misma función para el resumen.
- **Cuentas y botín:** el servidor guarda todo en SQLite (`node:sqlite`, integrado en Node, sin dependencias nativas). Las contraseñas se guardan con scrypt y la sesión es un token aleatorio que el cliente guarda. Las fórmulas de progresión (`packages/shared/src/progression.ts`) son compartidas, así que el arsenal muestra exactamente los mismos números que aplica el servidor.
- **Persecución de los zombis:** siguen un campo de flujo (Dijkstra sobre la rejilla) que se recalcula 4 veces por segundo, y se separan entre ellos con una rejilla espacial.
