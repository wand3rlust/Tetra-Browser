/**
 * Reconstructs process lineage from Tetragon events.
 *
 * Processes are identified by their unique exec_id and linked to parents
 * via parent_exec_id. Events observed within the log window supplement
 * this with embedded ancestors[] chains, giving lineage that predates
 * the captured log.
 */
import type { NormalizedEvent } from './normalize';
import type { Process, TetragonEventType } from './types';

export interface ProcessNode {
  execId: string;
  pid: number;
  binary: string;
  arguments: string;
  flags: string;
  startTime: string;
  namespace: string;
  podName: string;
  /** index of the process_exec event, if present in the log */
  execEventIndex: number | null;
  /** index of the process_exit event, if present in the log */
  exitEventIndex: number | null;
  /** tracing-policy event indexes fired by this process */
  kprobeEventIndexes: number[];
  /** all event indexes referencing this exec id */
  eventIndexes: number[];
  exitStatus?: number;
  exitSignal?: string;
  /** true if lineage came from an ancestors[] snapshot rather than an observed event */
  synthetic: boolean;
  parent: string | null;
  children: ProcessNode[];
  depth: number;
}

export interface ProcessTreeResult {
  /** all nodes keyed by exec_id */
  byExecId: Map<string, ProcessNode>;
  /** roots of the forest (nodes whose parent is absent or synthetic-rooted) */
  roots: ProcessNode[];
}

function emptyNode(execId: string): ProcessNode {
  return {
    execId,
    pid: 0,
    binary: '',
    arguments: '',
    flags: '',
    startTime: '',
    namespace: '',
    podName: '',
    execEventIndex: null,
    exitEventIndex: null,
    kprobeEventIndexes: [],
    eventIndexes: [],
    synthetic: true,
    parent: null,
    children: [],
    depth: 0,
  };
}

function nodeFromProcess(p: Process, parent: string | null): ProcessNode {
  const pod = p.pod;
  return {
    execId: p.exec_id ?? '',
    pid: p.pid ?? 0,
    binary: p.binary ?? '',
    arguments: p.arguments ?? '',
    flags: p.flags ?? '',
    startTime: p.start_time ?? '',
    namespace: pod?.namespace ?? '',
    podName: pod?.name ?? '',
    execEventIndex: null,
    exitEventIndex: null,
    kprobeEventIndexes: [],
    eventIndexes: [],
    synthetic: false,
    parent,
    children: [],
    depth: 0,
  };
}

/**
 * Build a process forest from normalized events.
 * Exec/exit events contribute observed nodes; ancestors[] snapshots
 * fill in unobserved lineage.
 */
export function buildProcessTree(events: NormalizedEvent[]): ProcessTreeResult {
  const byExecId = new Map<string, ProcessNode>();
  const roots: ProcessNode[] = [];

  const ensure = (proc: Process, parentExecId: string | null): ProcessNode => {
    const id = proc.exec_id ?? '';
    if (!id) return emptyNode('');
    let node = byExecId.get(id);
    if (!node) {
      node = nodeFromProcess(proc, parentExecId ?? null);
      byExecId.set(id, node);
    } else {
      // upgrade a synthetic node with observed details
      if (node.synthetic) {
        const fresh = nodeFromProcess(proc, parentExecId ?? node.parent);
        fresh.execEventIndex = node.execEventIndex;
        fresh.exitEventIndex = node.exitEventIndex;
        fresh.kprobeEventIndexes = node.kprobeEventIndexes;
        fresh.eventIndexes = node.eventIndexes;
        byExecId.set(id, fresh);
        node = fresh;
      }
      if (parentExecId) node.parent = parentExecId;
    }
    return node;
  };

  // pass 1: materialize nodes from process/parent/ancestors of every event
  for (const e of events) {
    const raw = (e.raw ?? {}) as Record<string, unknown>;
    const type = e.type;
    if (type === 'unknown' || type === 'rate_limit_info' || type === 'test' || type === 'process_throttle') continue;
    const payload = (raw[type] ?? {}) as Record<string, unknown>;

    const process = payload.process as Process | undefined;
    const parent = payload.parent as Process | undefined;
    const ancestors = (payload.ancestors as Process[] | undefined) ?? [];

    if (process?.exec_id) {
      const node = ensure(process, process.parent_exec_id ?? null);
      node.eventIndexes.push(e.index);
      if (type === 'process_exec') node.execEventIndex = e.index;
      if (type === 'process_exit') {
        node.exitEventIndex = e.index;
        node.exitStatus = e.exitStatus;
        node.exitSignal = e.exitSignal;
      }
      if (type !== 'process_exec' && type !== 'process_exit' && type !== 'process_loader') {
        node.kprobeEventIndexes.push(e.index);
      }
    }
    if (parent?.exec_id) {
      const pNode = ensure(parent, parent.parent_exec_id ?? null);
      pNode.eventIndexes.push(e.index);
    }
    for (const anc of ancestors) {
      if (anc?.exec_id) ensure(anc, anc.parent_exec_id ?? null);
    }
  }

  // pass 2: link children under parents; assign depths; collect roots
  for (const node of byExecId.values()) {
    const parent = node.parent ? byExecId.get(node.parent) : undefined;
    if (parent && !parent.children.includes(node)) parent.children.push(node);
  }
  for (const node of byExecId.values()) {
    const parent = node.parent ? byExecId.get(node.parent) : undefined;
    if (!parent) {
      // parent missing from data --> this node is a forest root
      roots.push(node);
      assignDepth(node, 0);
    }
  }
  // handle cycles defensively (shouldn't happen, but corrupted logs...)
  for (const node of byExecId.values()) {
    if (node.depth === 0 && !roots.includes(node)) {
      roots.push(node);
      assignDepth(node, 0);
    }
  }

  // stable ordering: by start time then pid
  const byTime = (a: ProcessNode, b: ProcessNode) =>
    (a.startTime && b.startTime ? a.startTime.localeCompare(b.startTime) : a.pid - b.pid);
  roots.sort(byTime);
  for (const node of byExecId.values()) node.children.sort(byTime);

  return { byExecId, roots };
}

function assignDepth(node: ProcessNode, depth: number): void {
  node.depth = depth;
  for (const child of node.children) assignDepth(child, depth + 1);
}

/** Find the ancestry path (root --> node) for highlighting an event's lineage. */
export function lineagePath(byExecId: Map<string, ProcessNode>, execId: string): ProcessNode[] {
  const path: ProcessNode[] = [];
  let cur = byExecId.get(execId);
  const seen = new Set<string>();
  while (cur && !seen.has(cur.execId)) {
    seen.add(cur.execId);
    path.unshift(cur);
    cur = cur.parent ? byExecId.get(cur.parent) : undefined;
  }
  return path;
}

export type { TetragonEventType };
