import { LAMPORTS_PER_SOL } from './constants.mjs';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));

export const c = {
  dim: wrap('2'),
  bold: wrap('1'),
  green: wrap('32'),
  yellow: wrap('33'),
  red: wrap('31'),
  cyan: wrap('36'),
  grey: wrap('90'),
};

/** Lamports as SOL, fixed to 6dp — enough to see dust, short enough to scan. */
export function sol(lamports) {
  return (lamports / LAMPORTS_PER_SOL).toFixed(6);
}

export const pad = (s, n) => String(s).padEnd(n);
export const padStart = (s, n) => String(s).padStart(n);

/**
 * Redraw a single status line in place, and clear it when finished.
 *
 * Silent when stderr is not a terminal: carriage-return overwriting only makes
 * sense on a live terminal, and piping it into a file or a capture leaves a
 * trail of half-overwritten counters instead of one tidy line.
 */
export const progress = (text) => {
  if (process.stderr.isTTY) process.stderr.write(`\r${c.dim(text)}\x1b[K`);
};
export const clearProgress = () => {
  if (process.stderr.isTTY) process.stderr.write('\r\x1b[K');
};

/** Compact counts for long runs: 1234567 -> 1,234,567 */
export const count = (n) => n.toLocaleString('en-US');

export function statusTag(status) {
  if (status === 'ready') return c.green('ready');
  if (status === 'blocked') return c.red('blocked');
  if (status === 'empty') return c.grey('empty');
  // With --no-preflight nothing has been simulated, so say that rather than
  // leaving a blank that reads as "fine".
  return c.yellow(status ?? 'unchecked');
}
