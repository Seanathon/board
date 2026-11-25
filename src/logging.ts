import { appendFileSync, chmodSync, mkdirSync, renameSync, rmSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { format } from 'node:util';

// The server's stdout can end up on a socket (or nowhere), so job errors and alerts
// were not recoverable after the fact. This tees console output to a size-rotated
// file under DATA_DIR. It adds a sink; it never changes what the console prints.

export interface FileLogOptions {
  file: string;
  /** Rotate when the file reaches this size. Default 5 MiB. */
  maxBytes?: number;
  /** Rotated files kept (`.1` newest). Default 3. */
  keep?: number;
  /** Test seam; defaults to the global console. */
  target?: Pick<Console, 'log' | 'info' | 'warn' | 'error'>;
}

const LEVELS = { log: 'INFO', info: 'INFO', warn: 'WARN', error: 'ERROR' } as const;

function rotate(file: string, keep: number): void {
  rmSync(`${file}.${keep}`, { force: true });
  for (let i = keep - 1; i >= 1; i--) if (existsSync(`${file}.${i}`)) renameSync(`${file}.${i}`, `${file}.${i + 1}`);
  renameSync(file, `${file}.1`);
}

/** Tee console.log/info/warn/error into `file`. Returns a function that restores the console. */
export function installConsoleFileLog(options: FileLogOptions): () => void {
  const target = options.target ?? console;
  const maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
  const keep = Math.max(1, options.keep ?? 3);
  const original = { log: target.log, info: target.info, warn: target.warn, error: target.error };
  let broken = false;

  const write = (level: string, args: unknown[]) => {
    if (broken) return;
    try {
      mkdirSync(path.dirname(options.file), { recursive: true, mode: 0o700 });
      if (existsSync(options.file) && statSync(options.file).size >= maxBytes) rotate(options.file, keep);
      const line = `${new Date().toISOString()} ${level} ${format(...(args as [unknown, ...unknown[]])).replace(/\r?\n/g, '\n  ')}\n`;
      appendFileSync(options.file, line, { mode: 0o600 });
      chmodSync(options.file, 0o600);
    } catch {
      broken = true; // a full disk must never take the server's own logging down
      original.warn.call(target, `file logging disabled: could not write ${options.file}`);
    }
  };

  for (const name of Object.keys(LEVELS) as Array<keyof typeof LEVELS>) {
    target[name] = (...args: unknown[]) => {
      original[name].apply(target, args as []);
      write(LEVELS[name], args);
    };
  }
  return () => { Object.assign(target, original); };
}
