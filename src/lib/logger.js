import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.resolve(__dirname, '../../', 'logs');

function ensureDir() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}
ensureDir();

/** Append a line to a dated log file (app-YYYY-MM-DD.log). */
function writeLine(file, line) {
  try {
    ensureDir();
    fs.appendFile(path.join(LOG_DIR, file), line + '\n', () => {});
  } catch {
    /* never let logging crash the app */
  }
}

function dated(prefix) {
  const day = new Date().toISOString().slice(0, 10);
  return `${prefix}-${day}.log`;
}

function stamp(level, msg, meta) {
  const ts = new Date().toISOString();
  const extra = meta ? ' ' + JSON.stringify(meta) : '';
  return `${ts} [${level}] ${msg}${extra}`;
}

export const logger = {
  info(msg, meta) {
    const line = stamp('INFO', msg, meta);
    writeLine(dated('app'), line);
  },
  warn(msg, meta) {
    const line = stamp('WARN', msg, meta);
    writeLine(dated('app'), line);
    // eslint-disable-next-line no-console
    console.warn(line);
  },
  error(msg, meta) {
    const line = stamp('ERROR', msg, meta);
    writeLine(dated('app'), line);
    writeLine(dated('error'), line);
    // eslint-disable-next-line no-console
    console.error(line);
  },
  /** Record a domain event (order placed, payment, auth) for audit trails. */
  event(name, meta) {
    writeLine(dated('events'), stamp('EVENT', name, meta));
  },
};

/** A write stream sink for morgan HTTP access logs. */
export const accessLogStream = {
  write(line) {
    writeLine(dated('access'), line.trim());
  },
};

export { LOG_DIR };
