/**
 * Data worker: owns the parsed events (raw + normalized) and the process
 * tree. Handles parsing, filtering/aggregation, visible-row windows,
 * single-event detail fetches, tree flattening and export serialization,
 * which keeps multi-million-event datasets off the main thread.
 */
import { parseFile } from '../parser/parse';
import { normalizeAll, signalName, type NormalizedEvent } from '../parser/normalize';
import { buildProcessTree, lineagePath, type ProcessNode, type ProcessTreeResult } from '../parser/processTree';
import { computeAggregates, sortMatched, EMPTY_AGGREGATES } from '../parser/aggregate';
import { filterEvents, type Filters } from '../parser/filtering';
import { csvHeader, csvRow } from '../utils/export';
import type { TetragonEvent } from '../parser/types';
import type { ToWorker, FromWorker, TreeLine, TreeData, EventRow, Dimensions, FileMeta } from './protocol';

const AUTO_COLLAPSE_THRESHOLD = 5000;
const AUTO_COLLAPSE_LIMIT = 20000;
const TREE_LINE_LIMIT = 10000;
const TREE_EXPORT_LIMIT = 100000;
const EXPORT_CHUNK = 5000;

let normalized: NormalizedEvent[] = [];
let rawLines: string[] = [];
let tree: ProcessTreeResult | null = null;

function post(msg: FromWorker): void {
  (self as unknown as Worker).postMessage(msg);
}

function toRow(e: NormalizedEvent): EventRow {
  const { raw: _raw, searchHay: _hay, ...row } = e;
  return row;
}

function csvEventRow(e: NormalizedEvent): string {
  return csvRow({
    time: e.time,
    type: e.type,
    node: e.nodeName,
    namespace: e.namespace,
    pod: e.podName,
    container: e.containerName,
    image: e.image,
    pid: e.pid,
    binary: e.binary,
    arguments: e.arguments,
    cwd: e.cwd,
    flags: e.flags,
    parent_binary: e.parentBinary,
    exit_status: e.exitStatus ?? '',
    function_name: e.functionName,
    policy_name: e.policyName,
    action: e.action,
    exec_id: e.execId,
  });
}

/** Apply the tree view's pod filter + event filters to the forest roots. */
function pruneTree(roots: ProcessNode[], filters: Filters, podFilter: string): ProcessNode[] {
  let result = roots;
  if (podFilter) {
    const contains = (n: ProcessNode): boolean => n.podName === podFilter || n.children.some(contains);
    result = result.filter(contains);
  }
  if (filters.namespaces.length || filters.pods.length || filters.binary || filters.search) {
    const podSet = new Set(filters.pods);
    const binaryLower = filters.binary.toLowerCase();
    const searchLower = filters.search.toLowerCase();
    const match = (n: ProcessNode): boolean =>
      (podSet.size === 0 || podSet.has(n.podName)) &&
      (!binaryLower || n.binary.toLowerCase().includes(binaryLower)) &&
      (!searchLower || `${n.binary} ${n.arguments}`.toLowerCase().includes(searchLower));
    const prune = (n: ProcessNode): ProcessNode | null => {
      const kids = n.children.map(prune).filter((k): k is ProcessNode => k !== null);
      if (match(n) || kids.length) return { ...n, children: kids };
      return null;
    };
    const pruned = result.map(prune).filter((r): r is ProcessNode => r !== null);
    if (pruned.length) result = pruned;
  }
  return result;
}

function handleTree(req: Extract<ToWorker, { kind: 'tree' }>): void {
  if (!tree) {
    post({ kind: 'treeResult', reqId: req.reqId, data: { lines: [], processCount: 0, rootCount: 0, truncated: false, autoCollapsed: null } });
    return;
  }
  const roots = pruneTree(tree.roots, req.filters, req.podFilter);

  // On the initial load of a very large tree, auto-collapse everything below depth 1
  let autoCollapsed: string[] | null = null;
  if (req.initial && tree.byExecId.size > AUTO_COLLAPSE_THRESHOLD) {
    autoCollapsed = [];
    const collect = (n: ProcessNode, depth: number): void => {
      if (n.children.length && depth >= 1 && autoCollapsed!.length < AUTO_COLLAPSE_LIMIT) autoCollapsed!.push(n.execId);
      for (const c of n.children) collect(c, depth + 1);
    };
    for (const r of roots) collect(r, 0);
  }

  const collapsedSet = new Set(req.collapsed);
  if (autoCollapsed) for (const id of autoCollapsed) collapsedSet.add(id);

  const selectedExecId =
    req.selectedEventIndex !== null && req.selectedEventIndex !== undefined
      ? normalized[req.selectedEventIndex]?.execId ?? null
      : null;
  const pathSet = new Set<string>();
  if (selectedExecId) for (const n of lineagePath(tree.byExecId, selectedExecId)) pathSet.add(n.execId);

  const lines: TreeLine[] = [];
  let truncated = false;
  const walk = (nodes: ProcessNode[], depth: number): boolean => {
    for (const n of nodes) {
      if (lines.length >= TREE_LINE_LIMIT) return true;
      lines.push({
        execId: n.execId,
        depth,
        binary: n.binary,
        arguments: n.arguments,
        pid: n.pid,
        namespace: n.namespace,
        podName: n.podName,
        exitStatus: n.exitStatus,
        exitSignal: n.exitSignal,
        kprobeCount: n.kprobeEventIndexes.length,
        hasChildren: n.children.length > 0,
        synthetic: n.synthetic,
        execEventIndex: n.execEventIndex,
        exitEventIndex: n.exitEventIndex,
        firstHookIndex: n.kprobeEventIndexes[0] ?? null,
        onPath: pathSet.has(n.execId),
        selected: n.execId === selectedExecId,
      });
      if (n.children.length && !collapsedSet.has(n.execId) && walk(n.children, depth + 1)) return true;
    }
    return false;
  };
  truncated = walk(roots, 0);

  const data: TreeData = {
    lines,
    processCount: tree.byExecId.size,
    rootCount: roots.length,
    truncated,
    autoCollapsed,
  };
  post({ kind: 'treeResult', reqId: req.reqId, data });
}

function handleExport(req: Extract<ToWorker, { kind: 'export' }>): void {
  const matched = filterEvents(normalized, req.filters);
  sortMatched(matched, req.sort);
  if (req.format === 'csv') {
    post({ kind: 'exportChunk', token: req.token, text: csvHeader(), done: false });
    if (matched.length === 0) {
      post({ kind: 'exportChunk', token: req.token, text: '', done: true });
      return;
    }
    for (let i = 0; i < matched.length; i += EXPORT_CHUNK) {
      const slice = matched.slice(i, i + EXPORT_CHUNK);
      const text = slice.map(csvEventRow).join('\n');
      post({ kind: 'exportChunk', token: req.token, text: i > 0 ? `\n${text}` : text, done: i + EXPORT_CHUNK >= matched.length });
    }
  } else {
    if (matched.length === 0) {
      post({ kind: 'exportChunk', token: req.token, text: '[]', done: true });
      return;
    }
    for (let i = 0; i < matched.length; i += EXPORT_CHUNK) {
      const slice = matched.slice(i, i + EXPORT_CHUNK);
      const text = slice.map((e) => (e.raw !== undefined ? JSON.stringify(e.raw, null, 2) : rawLines[e.index] ?? '{}')).join(',\n');
      const isLast = i + EXPORT_CHUNK >= matched.length;
      const prefix = i > 0 ? ',\n' : '[\n';
      const suffix = isLast ? '\n]' : '';
      post({ kind: 'exportChunk', token: req.token, text: prefix + text + suffix, done: isLast });
    }
  }
}

function handleTreeExport(req: Extract<ToWorker, { kind: 'treeExport' }>): void {
  const roots = tree ? pruneTree(tree.roots, req.filters, req.podFilter) : [];
  const collapsedSet = new Set(req.collapsed);
  const out: string[] = [];
  let truncated = false;
  const walk = (nodes: ProcessNode[], depth: number): boolean => {
    for (const n of nodes) {
      if (out.length >= TREE_EXPORT_LIMIT) return true;
      const status =
        n.exitEventIndex !== null ? ` [exit ${n.exitStatus ?? (n.exitSignal !== undefined ? signalName(n.exitSignal) : '?')}]` : '';
      const kp = n.kprobeEventIndexes.length ? ` {${n.kprobeEventIndexes.length} hook events}` : '';
      out.push(`${'  '.repeat(depth)}${n.binary || '(unknown)'} ${n.arguments} (pid ${n.pid})${status}${kp}`);
      if (n.children.length && !collapsedSet.has(n.execId) && walk(n.children, depth + 1)) return true;
    }
    return false;
  };
  truncated = walk(roots, 0);
  if (truncated) out.push('… (tree export truncated)');
  const text = out.join('\n');
  post({ kind: 'exportChunk', token: req.token, text, done: true });
}

self.onmessage = (ev: MessageEvent<ToWorker>) => {
  const msg = ev.data;
  try {
    switch (msg.kind) {
      case 'parse': {
        const fileInfos: FileMeta[] = [];
        const allEvents: TetragonEvent[] = [];
        const allRawLines: string[] = [];
        for (const f of msg.files) {
          const result = parseFile(new Uint8Array(f.bytes), (processed, total) => {
            post({ kind: 'progress', id: msg.id, fileName: f.name, processed, total });
          });
          fileInfos.push({
            name: f.name,
            format: result.format,
            wasGzip: result.wasGzip,
            size: f.bytes.byteLength,
            eventCount: result.events.length,
            warnings: result.warnings,
          });
          for (const e of result.events) allEvents.push(e);
          for (const l of result.rawLines) allRawLines.push(l);
        }
        normalized = normalizeAll(allEvents);
        tree = buildProcessTree(normalized);
        // The parsed raw objects were only needed for normalization and tree
        // construction. Drop them and keep the original line text instead
        // (several times less memory, re-parsed on demand for detail/export).
        for (const e of normalized) e.raw = undefined;
        rawLines = allRawLines;

        const types = new Set<string>();
        const namespaces = new Set<string>();
        const pods = new Set<string>();
        const nodes = new Set<string>();
        for (const e of normalized) {
          if (e.type !== 'unknown') types.add(e.type);
          if (e.namespace) namespaces.add(e.namespace);
          if (e.podName) pods.add(e.podName);
          if (e.nodeName) nodes.add(e.nodeName);
        }
        const dimensions: Dimensions = {
          types: [...types].sort(),
          namespaces: [...namespaces].sort((a, b) => a.localeCompare(b)),
          pods: [...pods].sort((a, b) => a.localeCompare(b)),
          nodes: [...nodes].sort((a, b) => a.localeCompare(b)),
        };
        post({ kind: 'done', id: msg.id, files: fileInfos, eventCount: normalized.length, dimensions });
        break;
      }
      case 'filter': {
        const aggregates = normalized.length
          ? computeAggregates(normalized, msg.filters, msg.sort)
          : { ...EMPTY_AGGREGATES, total: 0 };
        post({ kind: 'filterResult', queryId: msg.queryId, aggregates });
        break;
      }
      case 'rows': {
        const rows: EventRow[] = [];
        for (const i of msg.indexes) {
          const e = normalized[i];
          if (e) rows.push(toRow(e));
        }
        post({ kind: 'rowsResult', reqId: msg.reqId, rows });
        break;
      }
      case 'raw': {
        const e = normalized[msg.index];
        let detail = null;
        if (e) {
          // re-parse the original line text on demand (raw objects are dropped after load)
          const rawText = rawLines[msg.index];
          const raw = rawText !== undefined ? (JSON.parse(rawText) as TetragonEvent) : e.raw;
          if (raw) {
            detail = { event: { ...e, raw }, lineage: tree && e.execId ? lineagePath(tree.byExecId, e.execId) : [] };
          }
        }
        post({ kind: 'rawResult', reqId: msg.reqId, detail });
        break;
      }
      case 'tree':
        handleTree(msg);
        break;
      case 'export':
        handleExport(msg);
        break;
      case 'treeExport':
        handleTreeExport(msg);
        break;
    }
  } catch (e) {
    if ('id' in msg) {
      post({ kind: 'error', id: msg.id, message: (e as Error).message ?? String(e) });
    }
  }
};
