/**
 * Normalizes raw Tetragon events into flat index records for fast
 * table rendering, filtering, and charting. The raw event is kept by
 * reference for the detail panel.
 */
import type {
  KprobeArgument,
  Process,
  TetragonEvent,
  TetragonEventType,
} from './types';
import { getEventType } from './parse';

export interface ExecIdInfo {
  /** decoded node name */
  node: string;
  /** boot-relative ktime (nanoseconds) */
  ktime: number;
  /** pid encoded in the exec id */
  pid: number;
  /** true if the exec id could be decoded */
  valid: boolean;
}

export function decodeExecId(execId?: string): ExecIdInfo {
  if (!execId) return { node: '', ktime: 0, pid: 0, valid: false };
  try {
    const decoded = atob(execId);
    // format: <node>:<ktime>:<pid>
    const firstColon = decoded.indexOf(':');
    const lastColon = decoded.lastIndexOf(':');
    if (firstColon === -1) return { node: decoded, ktime: 0, pid: 0, valid: false };
    const node = decoded.slice(0, firstColon);
    const ktime = Number(decoded.slice(firstColon + 1, lastColon > firstColon ? lastColon : undefined));
    const pid = lastColon > firstColon ? Number(decoded.slice(lastColon + 1)) : NaN;
    return { node, ktime: Number.isFinite(ktime) ? ktime : 0, pid: Number.isFinite(pid) ? pid : 0, valid: true };
  } catch {
    return { node: '', ktime: 0, pid: 0, valid: false };
  }
}

/** format a size in bytes to a human readable string */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n)) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

/** Format an RFC3339 timestamp for display, keeping sub-second precision short. */
export function formatTime(ts?: string): string {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.` +
    `${pad(d.getMilliseconds(), 3)}`
  );
}

/** Compact table time: "MM-DD HH:MM:SS"; the full value goes in the tooltip. */
export function formatTimeShort(ts?: string): string {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/** Parse RFC3339 to epoch ms; NaN if missing/invalid. */
export function parseTime(ts?: string): number {
  if (!ts) return NaN;
  const t = new Date(ts).getTime();
  return Number.isNaN(t) ? NaN : t;
}

/** Linux signal to display name: numbers map to names; string names pass through. */
export function signalName(sig?: number | string): string {
  if (sig === undefined || sig === null || sig === '') return '';
  const n = Number(sig);
  if (!Number.isNaN(n) && sig !== '') {
    const names: Record<number, string> = {
      1: 'SIGHUP', 2: 'SIGINT', 3: 'SIGQUIT', 4: 'SIGILL', 5: 'SIGTRAP', 6: 'SIGABRT',
      7: 'SIGBUS', 8: 'SIGFPE', 9: 'SIGKILL', 10: 'SIGUSR1', 11: 'SIGSEGV', 12: 'SIGUSR2',
      13: 'SIGPIPE', 14: 'SIGALRM', 15: 'SIGTERM', 16: 'SIGSTKFLT', 17: 'SIGCHLD',
      18: 'SIGCONT', 19: 'SIGSTOP', 20: 'SIGTSTP', 21: 'SIGTTIN', 22: 'SIGTTOU',
      23: 'SIGURG', 24: 'SIGXCPU', 25: 'SIGXFSZ', 26: 'SIGVTALRM', 27: 'SIGPROF',
      28: 'SIGWINCH', 29: 'SIGIO', 30: 'SIGPWR', 31: 'SIGSYS',
    };
    return names[n] ?? `SIG?(${n})`;
  }
  return String(sig);
}

/** Normalized flat record for one event.
 *  `raw` is dropped after process-tree construction when the dataset is
 *  held by the data worker (the original line text is kept instead and
 *  re-parsed on demand), so treat it as optional. */
export interface NormalizedEvent {
  /** index in the global events array */
  index: number;
  type: TetragonEventType | 'unknown';
  raw?: TetragonEvent;

  // envelope
  time: string;
  timeMs: number;
  nodeName: string;
  clusterName: string;

  // process (from the event-specific payload)
  execId: string;
  parentExecId: string;
  pid: number;
  binary: string;
  arguments: string;
  cwd: string;
  flags: string;
  startTime: string;

  // kubernetes context
  namespace: string;
  podName: string;
  containerName: string;
  image: string;
  workload: string;

  // exit
  exitStatus?: number;
  exitSignal?: string;

  // tracing policy
  functionName: string;
  policyName: string;
  action: string;
  message: string;
  tags: string[];

  /** parent process binary (for lineage at a glance) */
  parentBinary: string;

  /** precomputed lowercase-ish haystack for the free-text search filter */
  searchHay: string;
}

interface EventPayload {
  process?: Process;
  parent?: Process;
  signal?: string;
  status?: number;
  function_name?: string;
  policy_name?: string;
  action?: string;
  message?: string;
  tags?: string[];
  subsys?: string;
  event?: string;
  path?: string;
  symbol?: string;
}

function payloadFor(event: TetragonEvent, type: TetragonEventType | 'unknown'): EventPayload & { args?: KprobeArgument[] } {
  const payload = (type !== 'unknown' ? (event as Record<string, unknown>)[type] : undefined) as
    | (EventPayload & { args?: KprobeArgument[] })
    | undefined;
  return payload ?? {};
}

export function normalizeEvent(raw: TetragonEvent, index: number): NormalizedEvent {
  const type = getEventType(raw);
  const p = payloadFor(raw, type);
  const proc = p.process ?? {};
  const parent = p.parent ?? {};
  const pod = proc.pod ?? {};
  const container = pod.container ?? {};

  let exitStatus: number | undefined;
  let exitSignal: string | undefined;
  if (type === 'process_exit') {
    exitStatus = p.status;
    const sig = p.signal;
    if (typeof sig === 'string' && sig !== '') {
      exitSignal = Number.isNaN(Number(sig)) ? sig : signalName(Number(sig));
    } else if (typeof sig === 'number') {
      exitSignal = signalName(sig);
    }
  }

  let functionName = p.function_name ?? '';
  if (type === 'process_tracepoint' && !functionName) {
    const subsys = (p as { subsys?: string }).subsys ?? '';
    const ev = (p as { event?: string }).event ?? '';
    functionName = subsys && ev ? `${subsys}:${ev}` : subsys || ev;
  } else if (type === 'process_uprobe') {
    const sym = (p as { symbol?: string }).symbol ?? '';
    const path = (p as { path?: string }).path ?? '';
    functionName = sym || path;
  } else if (type === 'process_usdt') {
    const prov = (p as { provider?: string }).provider ?? '';
    const name = (p as { name?: string }).name ?? '';
    functionName = prov && name ? `${prov}:${name}` : prov || name;
  }

  const time = raw.time ?? (type === 'process_exit' ? (p as { time?: string }).time ?? '' : '');

  const namespace = pod.namespace ?? '';
  const podName = pod.name ?? '';
  const binary = proc.binary ?? '';
  const arguments_ = proc.arguments ?? '';
  const tags = p.tags ?? [];
  const policyName = p.policy_name ?? '';

  return {
    index,
    type,
    raw,
    time,
    timeMs: parseTime(time),
    nodeName: raw.node_name ?? '',
    clusterName: raw.cluster_name ?? '',
    execId: proc.exec_id ?? '',
    parentExecId: proc.parent_exec_id ?? '',
    pid: proc.pid ?? 0,
    binary,
    arguments: arguments_,
    cwd: proc.cwd ?? '',
    flags: proc.flags ?? '',
    startTime: proc.start_time ?? '',
    namespace,
    podName,
    containerName: container.name ?? '',
    image: container.image?.name ?? '',
    workload: pod.workload ?? '',
    exitStatus,
    exitSignal,
    functionName,
    policyName,
    action: p.action ?? '',
    message: p.message ?? '',
    tags,
    parentBinary: parent.binary ?? '',
    searchHay: `${binary} ${arguments_} ${podName} ${namespace} ${raw.node_name ?? ''} ${policyName} ${functionName} ${tags.join(' ')}`,
  };
}

export function normalizeAll(events: TetragonEvent[]): NormalizedEvent[] {
  return events.map(normalizeEvent);
}
