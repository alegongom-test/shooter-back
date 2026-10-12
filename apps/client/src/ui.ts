import {
  CLASSES,
  DAMAGE_TYPES,
  DAMAGE_TYPE_NAMES,
  LOADOUT_SLOTS,
  PLAYER_COLORS,
  SKILLS,
  SLOT_NAMES,
  buildCombatSetup,
  getClassSafe,
  isArmor,
  itemArmor,
  itemName,
  itemSlotKind,
  itemWeapon,
  rarityDef,
  sellValue,
  skillBlockReason,
  skillTree,
  spentPoints,
  upgradeCost,
  type EndStats,
  type ItemData,
  type RewardView,
} from '@horda/shared';
import { defaultServer, load, normalizeServerUrl, params, save } from './config';
import { session } from './session';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const overlay = $('overlay');
const panels = {
  auth: $('auth'),
  home: $('home'),
  arsenal: $('arsenal'),
  skills: $('skills'),
  lobby: $('lobby'),
  results: $('results'),
};
type PanelName = keyof typeof panels | null;

const serverInput = $<HTMLInputElement>('server');
const userInput = $<HTMLInputElement>('user');
const passInput = $<HTMLInputElement>('pass');
const codeInput = $<HTMLInputElement>('code');
const lagInput = $<HTMLInputElement>('lag');
const jitterInput = $<HTMLInputElement>('jitter');
const btnResume = $<HTMLButtonElement>('btn-resume');
const btnStart = $<HTMLButtonElement>('btn-start');

let current: PanelName = 'auth';

function show(panel: PanelName): void {
  current = panel;
  overlay.classList.toggle('hidden', panel === null);
  document.body.classList.toggle('in-game', panel === null);
  for (const [k, el] of Object.entries(panels)) el.classList.toggle('hidden', k !== panel);
}

function status(id: string, msg: string, error = false): void {
  const el = $(id);
  el.textContent = msg;
  el.classList.toggle('error', error);
}

/** Crea un elemento con texto y atributos (nunca usa innerHTML con datos de usuario). */
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { [key: string]: unknown; style?: string } = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  const { style, ...rest } = props;
  Object.assign(e, rest);
  if (style) e.setAttribute('style', style);
  e.append(...children);
  return e;
}

// ───────────── Conexión y cuenta ─────────────

async function ensureConnected(): Promise<boolean> {
  const url = normalizeServerUrl(serverInput.value);
  if (!url) {
    status('auth-status', 'Escribe la dirección del servidor (por ejemplo 192.168.1.20:2567)', true);
    return false;
  }
  save('server', serverInput.value.trim());
  status('auth-status', `Conectando a ${url}…`);
  try {
    await session.connect(url, Number(lagInput.value) || 0, Number(jitterInput.value) || 0);
    status('auth-status', '');
    return true;
  } catch (e) {
    status('auth-status', `${(e as Error).message}: ${url}`, true);
    return false;
  }
}

async function authWith(action: 'login' | 'register'): Promise<void> {
  const user = userInput.value.trim();
  const pass = passInput.value;
  if (!user || !pass) {
    status('auth-status', 'Escribe usuario y contraseña', true);
    return;
  }
  if (!(await ensureConnected())) return;
  save('user', user);
  if (action === 'login') session.login(user, pass);
  else session.register(user, pass);
}

async function resumeSession(): Promise<void> {
  const token = load('token');
  if (!token || !(await ensureConnected())) return;
  session.resume(token);
}

function refreshResumeButton(): void {
  const token = load('token');
  const user = load('user');
  btnResume.classList.toggle('hidden', !token || !user);
  btnResume.textContent = `Continuar como ${user ?? ''}`;
}

// ───────────── Inicio ─────────────

function renderHome(): void {
  const p = session.profile;
  if (!p) return;
  $('p-name').textContent = p.username;
  $('p-cash').textContent = `$${p.cash}`;
  $('p-level').textContent = `Nivel ${p.level}`;
  const span = Math.max(1, p.xpNextLevel - p.xpLevelStart);
  const into = p.xp - p.xpLevelStart;
  $('p-xp').textContent = `${into} / ${span} XP`;
  $('p-xpbar').style.width = `${Math.min(100, (into / span) * 100)}%`;
  $('p-stats').textContent = `${p.stats.games} partidas · ${p.stats.wins} victorias · ${p.stats.kills} bajas · ${p.items.length} objetos`;
  renderClassPicker($('home-classes'));
}

// ───────────── Clases y habilidades ─────────────

function renderClassPicker(container: HTMLElement): void {
  const p = session.profile;
  if (!p) return;
  container.replaceChildren(
    ...CLASSES.map((c) => {
      const free = p.skillPoints - spentPoints(p.skills[c.id]);
      return el(
        'button',
        {
          className: `class-card${c.id === p.classId ? ' selected' : ''}`,
          title: c.description,
          onclick: () => {
            if (c.id !== p.classId) session.setClass(c.id);
          },
        },
        el('strong', {}, c.name),
        el('span', {}, c.ability.name),
        free > 0 ? el('span', { style: 'color:var(--accent)' }, `${free} punto(s) libres`) : '',
      );
    }),
  );
}

function renderSkills(): void {
  const p = session.profile;
  if (!p) return;
  const cls = getClassSafe(p.classId);
  const ranks = p.skills[cls.id] ?? {};
  const free = p.skillPoints - spentPoints(ranks);
  $('s-points').textContent = `${cls.name} · ${free} punto(s)`;
  renderClassPicker($('s-classes'));

  const tree = skillTree(cls.id);
  const tiers = [...new Set(tree.map((s) => s.tier))].sort();
  $('s-tree').replaceChildren(
    ...tiers.map((tier) => {
      const need = SKILLS.tierRequirements[tier - 1] ?? 0;
      const locked = spentPoints(ranks) < need;
      return el(
        'div',
        { className: `tier${locked ? ' locked' : ''}` },
        el('div', { className: 'tier-label' }, `Nivel ${tier}${need ? ` · requiere ${need} puntos en el árbol` : ''}`),
        ...tree
          .filter((s) => s.tier === tier)
          .map((s) => {
            const rank = ranks[s.id] ?? 0;
            const reason = skillBlockReason(cls.id, ranks, s.id, p.level);
            return el(
              'div',
              { className: 'skill' },
              el(
                'div',
                { className: 'skill-info' },
                el('div', { className: 'item-name' }, s.name),
                el('div', { className: 'muted small' }, s.description),
                el('div', { className: 'pips' }, '●'.repeat(rank) + '○'.repeat(s.maxRank - rank)),
              ),
              el('button', { disabled: !!reason, title: reason ?? '', onclick: () => session.learnSkill(cls.id, s.id) }, '+'),
            );
          }),
      );
    }),
  );

  // Resumen calculado con las mismas reglas que el servidor.
  const items = p.loadout.map((id) => p.items.find((i) => i.id === id));
  const st = buildCombatSetup(cls.id, p.level, ranks, items);
  const res = DAMAGE_TYPES.map((t) => `${DAMAGE_TYPE_NAMES[t]} ${pct(st.resist[t])}`).join(' · ');
  const ab = st.ability;
  const abText =
    ab.id === 'heal'
      ? `cura ${ab.power} cada ${ab.cooldown} s`
      : ab.id === 'shield'
        ? `-${pct(ab.power)} daño durante ${ab.duration} s, cada ${ab.cooldown} s`
        : `+${pct(ab.power)} cadencia durante ${ab.duration} s, cada ${ab.cooldown} s`;
  $('s-summary').replaceChildren(
    el('div', {}, `Vida ${st.maxHp} · velocidad ${st.speed} · granadas ${st.grenades} (daño ${st.grenadeDamage}) · revivir ×${st.reviveSpeed}`),
    el('div', {}, `Resistencias: ${res} (${st.armorName})`),
    el('div', {}, `${ab.name}: ${abText}`),
    ...st.weapons.map((w) => el('div', {}, `${w.name}: daño ${w.damage}${w.pellets > 1 ? `×${w.pellets}` : ''} · ${w.fireRate}/s · cargador ${w.magSize} · recarga ${w.reloadTime} s`)),
  );
}

// ───────────── Arsenal ─────────────

const RARITY_ORDER = ['legendary', 'epic', 'rare', 'uncommon', 'common'];
let confirmSell = 0;

function itemLabel(item: ItemData): HTMLElement {
  const r = rarityDef(item.rarity);
  return el('span', { className: 'item-name', style: `color:${r.color}` }, itemName(item));
}

const pct = (v: number) => `${Math.round(v * 100)} %`;

function itemStats(item: ItemData): string {
  if (isArmor(item.base)) {
    const a = itemArmor(item);
    const res = DAMAGE_TYPES.map((t) => `${DAMAGE_TYPE_NAMES[t]} ${pct(a.resist[t])}`).join(' · ');
    return a.speed ? `${res} · velocidad ${pct(a.speed)}` : res;
  }
  const w = itemWeapon(item);
  const dmg = w.pellets > 1 ? `${w.damage}×${w.pellets}` : `${w.damage}`;
  return `Daño ${dmg} · ${w.fireRate}/s · cargador ${w.magSize}${w.pierce ? ` · atraviesa ${w.pierce}` : ''}`;
}

function renderArsenal(): void {
  const p = session.profile;
  if (!p) return;
  $('a-cash').textContent = `$${p.cash}`;

  const loadout = $('a-loadout');
  loadout.replaceChildren(
    ...LOADOUT_SLOTS.map((_, slot) => {
      const item = p.items.find((i) => i.id === p.loadout[slot]);
      return el(
        'div',
        { className: 'slot' },
        el('div', { className: 'slot-name' }, SLOT_NAMES[slot]),
        item ? itemLabel(item) : el('span', { className: 'muted' }, '—'),
      );
    }),
  );

  const sorted = [...p.items].sort((a, b) => {
    const ea = p.loadout.includes(a.id) ? 0 : 1;
    const eb = p.loadout.includes(b.id) ? 0 : 1;
    return ea - eb || RARITY_ORDER.indexOf(a.rarity) - RARITY_ORDER.indexOf(b.rarity) || b.level - a.level || a.id - b.id;
  });

  $('a-items').replaceChildren(
    ...sorted.map((item) => {
      const r = rarityDef(item.rarity);
      const equippedIn = p.loadout.indexOf(item.id);
      const kind = itemSlotKind(item);
      const actions = el('div', { className: 'item-actions' });

      LOADOUT_SLOTS.forEach((slotKind, slot) => {
        if (slotKind !== kind || slot === equippedIn) return;
        const label = kind === 'primary' ? `Equipar ${slot === 1 ? 'P1' : 'P2'}` : 'Equipar';
        actions.append(el('button', { onclick: () => session.equip(slot, item.id) }, label));
      });

      const cost = upgradeCost(item);
      actions.append(
        el(
          'button',
          {
            disabled: cost === null || cost > p.cash,
            onclick: () => session.upgrade(item.id),
          },
          cost === null ? 'Máx.' : `Mejorar $${cost}`,
        ),
      );

      if (equippedIn < 0) {
        const value = sellValue(item);
        const btn = el('button', {}, confirmSell === item.id ? `¿Vender por $${value}?` : `Vender $${value}`);
        btn.onclick = () => {
          if (confirmSell === item.id) {
            confirmSell = 0;
            session.sell(item.id);
          } else {
            confirmSell = item.id;
            renderArsenal();
          }
        };
        actions.append(btn);
      }

      const name = itemLabel(item);
      const info = el(
        'div',
        { className: 'item-info' },
        name,
        equippedIn >= 0 ? el('span', { className: 'equipped-tag' }, `● ${SLOT_NAMES[equippedIn]}`) : '',
        el('div', { className: 'muted small' }, `${r.name} · ${itemStats(item)}`),
      );
      return el('div', { className: 'item', style: `border-left-color:${r.color}` }, info, actions);
    }),
  );
}

// ───────────── Sala y resultados ─────────────

function renderLobby(): void {
  $('lobby-code').textContent = session.code;
  $('lobby-players').replaceChildren(
    ...session.players.map((p) => {
      const tags = [p.id === session.host ? 'anfitrión' : '', p.id === session.you ? 'tú' : ''].filter(Boolean);
      return el(
        'li',
        {},
        el('span', { className: 'dot', style: `background:${PLAYER_COLORS[p.color]}` }),
        el('span', {}, p.name),
        el('span', { className: 'muted small' }, `${getClassSafe(p.classId).name} · nv. ${p.level}`),
        tags.length ? el('span', { className: 'tag' }, tags.join(' · ')) : '',
      );
    }),
  );
  renderClassPicker($('lobby-classes'));
  const playing = session.roomPhase === 'playing';
  btnStart.classList.toggle('hidden', !session.isHost || playing);
  $('lobby-wait').textContent = playing
    ? 'Partida en curso…'
    : session.isHost
      ? 'Comparte el código con tus amigos.'
      : 'Esperando a que el anfitrión empiece…';
}

function renderResults(stats: EndStats): void {
  const title = $('results-title');
  title.textContent = stats.result === 'victory' ? '¡Victoria!' : 'Derrota';
  title.style.color = stats.result === 'victory' ? 'var(--accent)' : 'var(--danger)';
  const m = Math.floor(stats.elapsed / 60);
  const s = String(stats.elapsed % 60).padStart(2, '0');
  $('results-sub').textContent = `${m}:${s} · ${stats.kills} zombis abatidos`;
  const sorted = [...stats.players].sort((a, b) => b.kills - a.kills);
  $('results-table').replaceChildren(
    el('tr', {}, el('th', {}, 'Jugador'), el('th', {}, 'Bajas'), el('th', {}, 'Muertes'), el('th', {}, 'Revividos')),
    ...sorted.map((p) =>
      el('tr', {}, el('td', {}, p.name), el('td', {}, String(p.kills)), el('td', {}, String(p.deaths)), el('td', {}, String(p.revives))),
    ),
  );
  $('rewards').replaceChildren(el('p', { className: 'muted small' }, 'Calculando recompensas…'));
}

function renderRewards(r: RewardView): void {
  const box = $('rewards');
  box.replaceChildren(
    el('div', { className: 'reward-line' }, el('span', {}, `+${r.xp} XP`), el('span', { className: 'cash' }, `+$${r.cash}`)),
  );
  if (r.levelAfter > r.levelBefore) box.append(el('div', { className: 'level-up' }, `¡Subes a nivel ${r.levelAfter}!`));
  if (r.items.length) {
    box.append(el('p', { className: 'muted small' }, `${r.items.length} arma(s) de las cajas:`));
    for (const item of r.items) {
      box.append(el('div', { className: 'small' }, itemLabel(item), el('span', { className: 'muted' }, ` · ${rarityDef(item.rarity).name}`)));
    }
  } else {
    box.append(el('p', { className: 'muted small' }, 'No se recogió ninguna caja.'));
  }
}

// ───────────── Arranque ─────────────

export function initUI(onStart: () => void): void {
  serverInput.value = defaultServer();
  userInput.value = params.get('user') ?? load('user') ?? '';
  lagInput.value = params.get('lag') ?? '0';
  jitterInput.value = params.get('jitter') ?? '0';
  if (params.get('code')) codeInput.value = params.get('code')!.toUpperCase();
  refreshResumeButton();

  $<HTMLFormElement>('auth-form').onsubmit = (e) => {
    e.preventDefault();
    void authWith('login');
  };
  $('btn-register').onclick = () => void authWith('register');
  btnResume.onclick = () => void resumeSession();
  $('btn-logout').onclick = () => {
    session.logout();
    refreshResumeButton();
    show('auth');
  };

  $('btn-create').onclick = () => session.createRoom();
  $('btn-join').onclick = () => {
    const code = codeInput.value.trim().toUpperCase();
    if (code.length !== 4) {
      status('home-status', 'El código de sala tiene 4 letras', true);
      return;
    }
    session.joinRoom(code);
  };
  codeInput.onkeydown = (e) => {
    if (e.key === 'Enter') $('btn-join').click();
  };
  $('btn-arsenal').onclick = () => {
    confirmSell = 0;
    renderArsenal();
    show('arsenal');
  };
  $('btn-arsenal-back').onclick = () => show('home');
  $('btn-skills').onclick = () => {
    status('s-status', '');
    renderSkills();
    show('skills');
  };
  $('btn-skills-back').onclick = () => show('home');
  $('btn-skills-reset').onclick = () => {
    const cls = session.profile?.classId;
    if (cls) session.resetSkills(cls);
  };
  btnStart.onclick = () => session.startGame();
  $('btn-leave').onclick = () => {
    session.leaveRoom();
    renderHome();
    show('home');
  };
  $('btn-back').onclick = () => {
    renderLobby();
    show('lobby');
  };

  session.on('auth', () => {
    status('auth-status', '');
    passInput.value = '';
    refreshResumeButton();
    renderHome();
    show('home');
  });
  session.on('authError', (msg) => {
    status('auth-status', msg, true);
    if (current !== 'auth') show('auth');
    refreshResumeButton();
  });
  session.on('profile', () => {
    renderHome();
    if (current === 'arsenal') renderArsenal();
    if (current === 'skills') renderSkills();
    if (current === 'lobby') renderLobby();
  });
  session.on('loggedOut', () => show('auth'));
  session.on('welcome', () => {
    status('home-status', '');
    renderLobby();
    show('lobby');
  });
  session.on('lobby', () => {
    if (current === 'lobby') renderLobby();
  });
  session.on('start', () => {
    show(null);
    onStart();
  });
  session.on('end', (stats) => {
    renderResults(stats);
    show('results');
  });
  session.on('rewards', renderRewards);
  session.on('error', (msg) => {
    const where = ({ arsenal: 'a-status', skills: 's-status', home: 'home-status', auth: 'auth-status' } as Record<string, string>)[current ?? ''];
    if (where) status(where, msg, true);
  });
  session.on('disconnect', () => {
    show('auth');
    refreshResumeButton();
    status('auth-status', 'Conexión perdida con el servidor', true);
  });

  show('auth');

  // ?auto=1 entra (o crea la cuenta), crea una sala y empieza sola. Para desarrollo y pruebas.
  if (params.get('auto')) {
    const user = params.get('user') ?? 'tester';
    const pass = params.get('pass') ?? 'tester';
    let triedRegister = false;
    let autoStarted = false;
    session.on('authError', () => {
      if (triedRegister) return;
      triedRegister = true;
      session.register(user, pass);
    });
    session.on('auth', () => session.createRoom());
    session.on('lobby', () => {
      if (!autoStarted && session.isHost && session.roomPhase === 'lobby') {
        autoStarted = true;
        session.startGame();
      }
    });
    void ensureConnected().then((ok) => ok && session.login(user, pass));
  } else if (load('token')) {
    void resumeSession();
  }
}
