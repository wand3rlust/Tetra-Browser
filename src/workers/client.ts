/**
 * Client-side driver for the data worker.
 *
 * One singleton worker; requests are correlated via ids echoed back by the
 * worker. Filter results are keyed by the caller-supplied queryId so the
 * store can discard stale responses.
 */
import type { FileMeta, Dimensions, EventRow, EventDetailData, TreeData } from './protocol';
import type { Aggregates } from '../parser/aggregate';
import type { Filters, SortKey } from '../parser/filtering';

let worker: Worker | null = null;
let nextId = 1;

interface ParseWaiter {
  resolve: (v: { files: FileMeta[]; eventCount: number; dimensions: Dimensions }) => void;
  reject: (e: Error) => void;
  onProgress?: (p: { fileName: string; processed: number; total: number }) => void;
}

const parseWaiters = new Map<number, ParseWaiter>();
const filterWaiters = new Map<number, (a: Aggregates) => void>();
const rowsWaiters = new Map<number, (r: EventRow[]) => void>();
const rawWaiters = new Map<number, (d: EventDetailData | null) => void>();
const treeWaiters = new Map<number, (t: TreeData) => void>();
const exportWaiters = new Map<number, { parts: string[]; resolve: (parts: string[]) => void }>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./data.worker.ts', import.meta.url), { type: 'module' });
    worker.addEventListener('message', (ev: MessageEvent) => {
      const msg = ev.data;
      switch (msg.kind) {
        case 'progress': {
          parseWaiters.get(msg.id)?.onProgress?.(msg);
          return;
        }
        case 'done': {
          parseWaiters.get(msg.id)?.resolve({ files: msg.files, eventCount: msg.eventCount, dimensions: msg.dimensions });
          parseWaiters.delete(msg.id);
          return;
        }
        case 'error': {
          parseWaiters.get(msg.id)?.reject(new Error(msg.message));
          parseWaiters.delete(msg.id);
          return;
        }
        case 'filterResult': {
          filterWaiters.get(msg.queryId)?.(msg.aggregates);
          filterWaiters.delete(msg.queryId);
          return;
        }
        case 'rowsResult': {
          rowsWaiters.get(msg.reqId)?.(msg.rows);
          rowsWaiters.delete(msg.reqId);
          return;
        }
        case 'rawResult': {
          rawWaiters.get(msg.reqId)?.(msg.detail);
          rawWaiters.delete(msg.reqId);
          return;
        }
        case 'treeResult': {
          treeWaiters.get(msg.reqId)?.(msg.data);
          treeWaiters.delete(msg.reqId);
          return;
        }
        case 'exportChunk': {
          const w = exportWaiters.get(msg.token);
          if (!w) return;
          w.parts.push(msg.text);
          if (msg.done) {
            exportWaiters.delete(msg.token);
            w.resolve(w.parts);
          }
          return;
        }
      }
    });
  }
  return worker;
}

export interface ParseProgressInfo {
  fileName: string;
  processed: number;
  total: number;
}

export async function parseFiles(
  files: File[],
  onProgress?: (p: ParseProgressInfo) => void
): Promise<{ files: FileMeta[]; eventCount: number; dimensions: Dimensions }> {
  const id = nextId++;
  const w = getWorker();
  const buffers = await Promise.all(files.map((f) => f.arrayBuffer()));
  return new Promise((resolve, reject) => {
    parseWaiters.set(id, { resolve, reject, onProgress });
    // transfer the buffers (zero-copy) instead of structured-cloning potentially
    // hundreds of MB
    w.postMessage(
      { kind: 'parse', id, files: files.map((f, i) => ({ name: f.name, bytes: buffers[i] })) },
      { transfer: buffers }
    );
  });
}

export function requestFilter(queryId: number, filters: Filters, sort: SortKey): Promise<Aggregates> {
  const w = getWorker();
  return new Promise((resolve) => {
    filterWaiters.set(queryId, resolve);
    w.postMessage({ kind: 'filter', queryId, filters, sort });
  });
}

export function requestRows(indexes: number[]): Promise<EventRow[]> {
  const reqId = nextId++;
  const w = getWorker();
  return new Promise((resolve) => {
    rowsWaiters.set(reqId, resolve);
    w.postMessage({ kind: 'rows', reqId, indexes });
  });
}

export function getEventDetail(index: number): Promise<EventDetailData | null> {
  const reqId = nextId++;
  const w = getWorker();
  return new Promise((resolve) => {
    rawWaiters.set(reqId, resolve);
    w.postMessage({ kind: 'raw', reqId, index });
  });
}

export function requestTree(args: {
  filters: Filters;
  selectedEventIndex: number | null;
  podFilter: string;
  collapsed: string[];
  initial: boolean;
}): Promise<TreeData> {
  const reqId = nextId++;
  const w = getWorker();
  return new Promise((resolve) => {
    treeWaiters.set(reqId, resolve);
    w.postMessage({ kind: 'tree', reqId, ...args });
  });
}

export function requestExport(format: 'csv' | 'json', filters: Filters, sort: SortKey): Promise<string[]> {
  const token = nextId++;
  const w = getWorker();
  return new Promise((resolve) => {
    exportWaiters.set(token, { parts: [], resolve });
    w.postMessage({ kind: 'export', token, format, filters, sort });
  });
}

export function requestTreeExport(filters: Filters, podFilter: string, collapsed: string[]): Promise<string[]> {
  const token = nextId++;
  const w = getWorker();
  return new Promise((resolve) => {
    exportWaiters.set(token, { parts: [], resolve });
    w.postMessage({ kind: 'treeExport', token, filters, podFilter, collapsed });
  });
}
