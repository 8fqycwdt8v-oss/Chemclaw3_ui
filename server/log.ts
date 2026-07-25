/** Minimal levelled logger. A logging dependency would outweigh what this process actually logs. */

const LEVELS = ['error', 'warn', 'info', 'debug'] as const;
type Level = (typeof LEVELS)[number];

const configured = (process.env.LOG_LEVEL ?? 'info').toLowerCase() as Level;
const threshold = LEVELS.indexOf(configured) === -1 ? 2 : LEVELS.indexOf(configured);

const emit = (level: Level, message: string): void => {
  if (LEVELS.indexOf(level) > threshold) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}`;
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
};

export const log = {
  error: (m: string) => emit('error', m),
  warn: (m: string) => emit('warn', m),
  info: (m: string) => emit('info', m),
  debug: (m: string) => emit('debug', m),
};
