/**
 * Minimal levelled logger. A logging dependency would outweigh what this process actually logs.
 *
 * One JSON object per line, unless `LOG_LEVEL=debug`, where a human is reading and a padded text
 * line is easier. The field names are the Chemclaw service's own (`core/logging.py::JsonFormatter`
 * — `time`, `level`, `logger`, `message`, `correlation_id`, and caller fields nested under
 * `fields`), because the two processes' logs are read together and a BFF line that spelled the
 * join key differently would not join. `level` is uppercase and `WARNING` rather than `WARN` for
 * the same reason: it is what the other side emits.
 *
 * Structured, not interpolated, and that is what makes the access log below usable: a request rate
 * per route, a status distribution and a latency percentile are all queries over fields, and none
 * of them is answerable from a sentence.
 */

const LEVELS = ['error', 'warn', 'info', 'debug'] as const;
type Level = (typeof LEVELS)[number];

const configured = (process.env.LOG_LEVEL ?? 'info').toLowerCase() as Level;
const threshold = LEVELS.indexOf(configured) === -1 ? 2 : LEVELS.indexOf(configured);

/** `debug` is the mode a person is watching; everything else is a machine's. */
const asJson = configured !== 'debug';

/** The service's own spelling, so one query can select a severity across both processes. */
const SEVERITY: Record<Level, string> = {
  error: 'ERROR',
  warn: 'WARNING',
  info: 'INFO',
  debug: 'DEBUG',
};

const render = (level: Level, message: string, fields?: Record<string, unknown>): string => {
  if (!asJson) {
    const suffix = fields && Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : '';
    return `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}${suffix}`;
  }
  return JSON.stringify({
    time: new Date().toISOString(),
    level: SEVERITY[level],
    logger: 'chemclaw3-ui',
    message,
    // Nested rather than merged at the top level, exactly as the service does it: a field named
    // `level` arriving from a request must not rewrite the severity a log stack routes on.
    ...(fields && Object.keys(fields).length > 0 ? { fields } : {}),
  });
};

const emit = (level: Level, message: string, fields?: Record<string, unknown>): void => {
  if (LEVELS.indexOf(level) > threshold) return;
  const line = render(level, message, fields);
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
};

export const log = {
  error: (m: string, f?: Record<string, unknown>) => emit('error', m, f),
  warn: (m: string, f?: Record<string, unknown>) => emit('warn', m, f),
  info: (m: string, f?: Record<string, unknown>) => emit('info', m, f),
  debug: (m: string, f?: Record<string, unknown>) => emit('debug', m, f),
};
