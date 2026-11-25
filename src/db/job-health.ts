// Per-board job health: a rolling window of terminal outcomes, with ONE alert when
// the failure rate crosses a threshold and ONE recovery line when it clears.
//
// Nothing alerted when a board's items all started failing, so a broken analysis path
// was found by looking at cards. This turns that into a log line an operator (or a
// log-based alert rule) can match: `ALERT board <id>: ...`. Counts only; no item data.

export interface JobHealthOptions {
  /** Outcomes remembered per board. */
  window?: number;
  /** Minimum outcomes in the window before a rate means anything. */
  minJobs?: number;
  /** Failure rate (0..1) at or above which the board alerts. */
  threshold?: number;
  warn?: (message: string) => void;
  info?: (message: string) => void;
}

export interface BoardHealth {
  boardId: string;
  jobs: number;
  failures: number;
  failureRate: number;
  alerting: boolean;
}

export interface JobHealthMonitor {
  record(boardId: string, failed: boolean): void;
  snapshot(): BoardHealth[];
}

export function createJobHealthMonitor(options: JobHealthOptions = {}): JobHealthMonitor {
  const window = Math.max(1, options.window ?? 20);
  const minJobs = Math.min(window, Math.max(1, options.minJobs ?? 5));
  const threshold = options.threshold ?? 0.5;
  const warn = options.warn ?? ((m) => console.warn(m));
  const info = options.info ?? ((m) => console.log(m));
  const boards = new Map<string, { outcomes: boolean[]; alerting: boolean }>();

  const stats = (boardId: string, state: { outcomes: boolean[]; alerting: boolean }): BoardHealth => {
    const failures = state.outcomes.filter(Boolean).length;
    return { boardId, jobs: state.outcomes.length, failures, failureRate: state.outcomes.length ? failures / state.outcomes.length : 0, alerting: state.alerting };
  };

  return {
    record(boardId, failed) {
      const state = boards.get(boardId) ?? { outcomes: [], alerting: false };
      boards.set(boardId, state);
      state.outcomes.push(failed);
      if (state.outcomes.length > window) state.outcomes.shift();
      const s = stats(boardId, state);
      if (s.jobs < minJobs) return;
      const pct = Math.round(s.failureRate * 100);
      if (!state.alerting && s.failureRate >= threshold) {
        state.alerting = true;
        warn(`ALERT board ${boardId}: ${s.failures} of the last ${s.jobs} jobs failed (${pct}%, threshold ${Math.round(threshold * 100)}%)`);
      } else if (state.alerting && s.failureRate < threshold / 2) {
        state.alerting = false;
        info(`RECOVERED board ${boardId}: ${s.failures} of the last ${s.jobs} jobs failed (${pct}%)`);
      }
    },
    snapshot() {
      return [...boards].map(([id, state]) => stats(id, state)).sort((a, b) => a.boardId.localeCompare(b.boardId));
    },
  };
}

/** BOARD_ALERT_ERROR_RATE (0..1), BOARD_ALERT_MIN_JOBS, BOARD_ALERT_WINDOW; junk falls back to defaults. */
export function jobHealthOptionsFromEnv(env: NodeJS.ProcessEnv): JobHealthOptions {
  const num = (v: string | undefined, ok: (n: number) => boolean) => {
    const n = v === undefined || v.trim() === '' ? NaN : Number(v);
    return Number.isFinite(n) && ok(n) ? n : undefined;
  };
  return {
    threshold: num(env.BOARD_ALERT_ERROR_RATE, (n) => n > 0 && n <= 1),
    minJobs: num(env.BOARD_ALERT_MIN_JOBS, (n) => Number.isInteger(n) && n >= 1),
    window: num(env.BOARD_ALERT_WINDOW, (n) => Number.isInteger(n) && n >= 1),
  };
}

let shared: JobHealthMonitor | undefined;

/** The process-wide monitor fed by runItemJob and read by /api/health/jobs. */
export function jobHealth(): JobHealthMonitor {
  return (shared ??= createJobHealthMonitor(jobHealthOptionsFromEnv(process.env)));
}

/** Test seam: replace (or reset, with undefined) the shared monitor. */
export function setJobHealthMonitor(next: JobHealthMonitor | undefined): void {
  shared = next;
}
