import readline from 'node:readline';
import { c, pad, padStart, sol, statusTag } from './format.mjs';
import { isActionable, movedLamports } from './claim.mjs';

/**
 * Terminal multi-select. Dependency-free on purpose: this is one screen of
 * raw-mode keyhandling, which is cheaper than owning an interactive-prompt
 * library for it.
 *
 * space toggle · a all · n none · r ready only · enter confirm · q cancel
 */
export async function multiSelect(
  rows,
  { title = 'Select wallets', out = process.stdout, input = process.stdin } = {},
) {
  if (!input.isTTY) {
    throw new Error(
      'not a TTY — re-run with --all to select every claimable wallet non-interactively',
    );
  }

  // Pre-tick everything worth claiming; the common case is "take it all".
  // A sharing-config row moves real money while its own total reads zero, so
  // selection asks whether the row is actionable rather than whether this
  // wallet personally receives anything. Using totalLamports here silently
  // unticked the largest amounts on the list.
  const pickable = (r) => (r.status ?? 'ready') === 'ready' && isActionable(r);
  const selected = rows.map(pickable);
  let cursor = 0;
  const labelWidth = Math.min(24, Math.max(6, ...rows.map((r) => r.label.length)));

  readline.emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();

  const render = (first) => {
    if (!first) out.write(`\x1b[${rows.length + 4}A`);
    const total = rows.reduce((n, r, i) => n + (selected[i] ? movedLamports(r) : 0), 0);
    const count = selected.filter(Boolean).length;
    out.write(
      `\x1b[0J${c.bold(title)}  ${c.dim(`${count}/${rows.length} selected · ${sol(total)} SOL`)}\n`,
    );
    out.write(
      c.grey('space toggle · a all · n none · r ready only · enter confirm · q cancel') + '\n\n',
    );
    rows.forEach((r, i) => {
      const here = i === cursor;
      const box = selected[i] ? c.green('[x]') : '[ ]';
      const line = `${here ? c.cyan('>') : ' '} ${box} ${pad(r.label, labelWidth)} ${c.dim(r.publicKey.toBase58().slice(0, 8) + '…')} ${padStart(sol(movedLamports(r)), 12)} SOL  ${statusTag(r.status)}${r.reason ? c.dim(' · ' + r.reason.slice(0, 44)) : ''}`;
      out.write(line.slice(0, (out.columns ?? 120) + 40) + '\n');
    });
    out.write('\n');
  };

  render(true);

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      input.setRawMode(false);
      input.pause();
      input.removeListener('keypress', onKey);
    };

    function onKey(_str, key) {
      if (key.name === 'up' || key.name === 'k') cursor = (cursor - 1 + rows.length) % rows.length;
      else if (key.name === 'down' || key.name === 'j') cursor = (cursor + 1) % rows.length;
      else if (key.name === 'space') selected[cursor] = !selected[cursor];
      else if (key.name === 'a') selected.fill(true);
      else if (key.name === 'n') selected.fill(false);
      else if (key.name === 'r')
        rows.forEach((r, i) => {
          selected[i] = pickable(r);
        });
      else if (key.name === 'return') {
        cleanup();
        return resolve(rows.filter((_, i) => selected[i]));
      } else if (key.name === 'q' || key.name === 'escape' || (key.ctrl && key.name === 'c')) {
        cleanup();
        return reject(new Error('cancelled'));
      } else return;
      render(false);
    }

    input.on('keypress', onKey);
  });
}
