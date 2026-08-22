import readline from 'node:readline';
import { c, pad, padStart, sol, statusTag } from './format.mjs';

/**
 * Terminal multi-select. Dependency-free on purpose: this is one screen of
 * raw-mode keyhandling, which is cheaper than owning an interactive-prompt
 * library for it.
 *
 * space toggle · a all · n none · r ready only · enter confirm · q cancel
 */
export async function multiSelect(rows, { title = 'Select wallets' } = {}) {
  if (!process.stdin.isTTY) {
    throw new Error('not a TTY — re-run with --all to select every claimable wallet non-interactively');
  }

  // Pre-tick everything worth claiming; the common case is "take it all".
  const selected = rows.map((r) => (r.status ?? 'ready') === 'ready' && r.totalLamports > 0);
  let cursor = 0;
  const labelWidth = Math.min(24, Math.max(6, ...rows.map((r) => r.label.length)));

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();

  const render = (first) => {
    if (!first) process.stdout.write(`\x1b[${rows.length + 4}A`);
    const total = rows.reduce((n, r, i) => n + (selected[i] ? r.totalLamports : 0), 0);
    const count = selected.filter(Boolean).length;
    process.stdout.write(`\x1b[0J${c.bold(title)}  ${c.dim(`${count}/${rows.length} selected · ${sol(total)} SOL`)}\n`);
    process.stdout.write(c.grey('space toggle · a all · n none · r ready only · enter confirm · q cancel') + '\n\n');
    rows.forEach((r, i) => {
      const here = i === cursor;
      const box = selected[i] ? c.green('[x]') : '[ ]';
      const line = `${here ? c.cyan('>') : ' '} ${box} ${pad(r.label, labelWidth)} ${c.dim(r.publicKey.toBase58().slice(0, 8) + '…')} ${padStart(sol(r.totalLamports), 12)} SOL  ${statusTag(r.status)}${r.reason ? c.dim(' · ' + r.reason.slice(0, 44)) : ''}`;
      process.stdout.write(line.slice(0, (process.stdout.columns ?? 120) + 40) + '\n');
    });
    process.stdout.write('\n');
  };

  render(true);

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener('keypress', onKey);
    };

    function onKey(_str, key) {
      if (key.name === 'up' || key.name === 'k') cursor = (cursor - 1 + rows.length) % rows.length;
      else if (key.name === 'down' || key.name === 'j') cursor = (cursor + 1) % rows.length;
      else if (key.name === 'space') selected[cursor] = !selected[cursor];
      else if (key.name === 'a') selected.fill(true);
      else if (key.name === 'n') selected.fill(false);
      else if (key.name === 'r') rows.forEach((r, i) => { selected[i] = (r.status ?? 'ready') === 'ready' && r.totalLamports > 0; });
      else if (key.name === 'return') { cleanup(); return resolve(rows.filter((_, i) => selected[i])); }
      else if (key.name === 'q' || key.name === 'escape' || (key.ctrl && key.name === 'c')) {
        cleanup();
        return reject(new Error('cancelled'));
      } else return;
      render(false);
    }

    process.stdin.on('keypress', onKey);
  });
}
