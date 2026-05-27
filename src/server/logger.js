'use strict';

const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const configuredLevel = String(process.env.LOG_LEVEL || 'info').toLowerCase();
const activeLevel = LEVELS[configuredLevel] || LEVELS.info;

function formatTimestamp(date = new Date()) {
  return date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, 'Z');
}

function write(level, scope, message, meta) {
  if (LEVELS[level] < activeLevel) return;
  const paddedLevel = level.toUpperCase().padEnd(5);
  const paddedScope = String(scope || 'app').padEnd(10).slice(0, 10);
  const suffix = meta === undefined ? '' : ` ${formatMeta(meta)}`;
  const line = `${formatTimestamp()} ${paddedLevel} ${paddedScope} ${message}${suffix}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

function formatMeta(meta) {
  if (meta instanceof Error) return meta.stack || meta.message;
  if (typeof meta === 'string') return meta;
  try {
    return JSON.stringify(meta);
  } catch {
    return String(meta);
  }
}

module.exports = {
  debug: (scope, message, meta) => write('debug', scope, message, meta),
  info: (scope, message, meta) => write('info', scope, message, meta),
  warn: (scope, message, meta) => write('warn', scope, message, meta),
  error: (scope, message, meta) => write('error', scope, message, meta),
};
