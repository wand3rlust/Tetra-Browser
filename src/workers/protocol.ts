/**
 * Message protocol between the main thread and the data worker.
 *
 * The worker is the single owner of the parsed events (raw + normalized)
 * and the process tree. The main thread only ever receives metadata,
 * aggregates, visible-row windows and single-event details, never the
 * full dataset.
 */
import type { NormalizedEvent } from '../parser/normalize';
import type { ProcessNode } from '../parser/processTree';
import type { Filters, SortKey } from '../parser/filtering';
import type { Aggregates } from '../parser/aggregate';

export interface FileMeta {
  name: string;
  format: string;
  wasGzip: boolean;
  size: number;
  eventCount: number;
  warnings: { line: number; reason: string; excerpt: string }[];
}

/** Distinct filter-dimension values present in the loaded dataset. */
export interface Dimensions {
  types: string[];
  namespaces: string[];
  pods: string[];
  nodes: string[];
}

/** A table row: a normalized event stripped of its raw payload. */
export type EventRow = Omit<NormalizedEvent, 'raw' | 'searchHay'>;

/** A flattened process-tree row for the tree view. */
export interface TreeLine {
  execId: string;
  depth: number;
  binary: string;
  arguments: string;
  pid: number;
  namespace: string;
  podName: string;
  exitStatus?: number;
  exitSignal?: string;
  kprobeCount: number;
  hasChildren: boolean;
  synthetic: boolean;
  execEventIndex: number | null;
  exitEventIndex: number | null;
  firstHookIndex: number | null;
  onPath: boolean;
  selected: boolean;
}

export interface TreeData {
  lines: TreeLine[];
  processCount: number;
  rootCount: number;
  truncated: boolean;
  /** on the initial load of a very large tree: ids to seed the collapse state with */
  autoCollapsed: string[] | null;
}

/** Full detail payload for one selected event. */
export interface EventDetailData {
  event: NormalizedEvent;
  lineage: ProcessNode[];
}

export type ToWorker =
  | { kind: 'parse'; id: number; files: { name: string; bytes: ArrayBuffer }[] }
  | { kind: 'filter'; queryId: number; filters: Filters; sort: SortKey }
  | { kind: 'rows'; reqId: number; indexes: number[] }
  | { kind: 'raw'; reqId: number; index: number }
  | { kind: 'tree'; reqId: number; filters: Filters; selectedEventIndex: number | null; podFilter: string; collapsed: string[]; initial: boolean }
  | { kind: 'export'; token: number; format: 'csv' | 'json'; filters: Filters; sort: SortKey }
  | { kind: 'treeExport'; token: number; filters: Filters; podFilter: string; collapsed: string[] };

export type FromWorker =
  | { kind: 'progress'; id: number; fileName: string; processed: number; total: number }
  | { kind: 'done'; id: number; files: FileMeta[]; eventCount: number; dimensions: Dimensions }
  | { kind: 'error'; id: number; message: string }
  | { kind: 'filterResult'; queryId: number; aggregates: Aggregates }
  | { kind: 'rowsResult'; reqId: number; rows: EventRow[] }
  | { kind: 'rawResult'; reqId: number; detail: EventDetailData | null }
  | { kind: 'treeResult'; reqId: number; data: TreeData }
  | { kind: 'exportChunk'; token: number; text: string; done: boolean };
