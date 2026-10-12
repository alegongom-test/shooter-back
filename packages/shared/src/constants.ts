/** Ticks de simulación por segundo (servidor y predicción del cliente). */
export const TICK_RATE = 20;
export const TICK_MS = 1000 / TICK_RATE;
export const TICK_DT = 1 / TICK_RATE;

/** Las posiciones viajan como u16 = px * POS_SCALE (precisión 0.25 px, mapas de hasta 16383 px). */
export const POS_SCALE = 4;

export const DEFAULT_PORT = 2567;
export const MAX_PLAYERS = 4;

/** Retraso con el que el cliente pinta a las demás entidades para poder interpolar. */
export const INTERP_DELAY_MS = 100;

/** Colores de jugador por índice de color (0-3). */
export const PLAYER_COLORS = ['#4fc3f7', '#ffb74d', '#f06292', '#f5f5f5'];
