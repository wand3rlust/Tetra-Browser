/**
 * Pure filter logic for Tetragon event lists.
 *
 * Kept free of UI/store imports so it can run inside the data worker
 * and be unit-tested directly.
 */
import type { NormalizedEvent } from './normalize';
import type { TetragonEventType } from './types';

export interface Filters {
  /** selected event types; empty = all */
  types: TetragonEventType[];
  /** selected namespaces; empty = all */
  namespaces: string[];
  /** selected pod names; empty = all */
  pods: string[];
  /** selected node names; empty = all */
  nodes: string[];
  /** binary substring match (case-insensitive) */
  binary: string;
  /** free-text regex or plain substring across binary/args/pod/policy */
  search: string;
  /** [startMs, endMs] inclusive; null = all time */
  timeRange: [number, number] | null;
  /** when true, only events inside k8s pods; false = only host processes; null = both */
  inPod: boolean | null;
}

export const emptyFilters: Filters = {
  types: [],
  namespaces: [],
  pods: [],
  nodes: [],
  binary: '',
  search: '',
  timeRange: null,
  inPod: null,
};

/** Sort order applied to the (filtered) event list. */
export interface SortKey {
  key: 'time' | 'type' | 'binary' | 'pod' | 'node' | 'pid' | 'status';
  dir: 1 | -1;
}

export const defaultSort: SortKey = { key: 'time', dir: 1 };

/** Compile the free-text search into a RegExp (case-insensitive; falls back to literal). */
export function compileSearch(search: string): RegExp | null {
  if (!search) return null;
  try {
    return new RegExp(search, 'i');
  } catch {
    return new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }
}

/** Apply the current filters to the event list. */
export function filterEvents(events: NormalizedEvent[], filters: Filters): NormalizedEvent[] {
  const regex = compileSearch(filters.search);
  const binaryLower = filters.binary ? filters.binary.toLowerCase() : '';
  const [tStart, tEnd] = filters.timeRange ?? [0, 0];
  const timeActive = filters.timeRange !== null;
  return events.filter((e) => {
    if (filters.types.length && !filters.types.includes(e.type as TetragonEventType)) return false;
    if (filters.namespaces.length && !filters.namespaces.includes(e.namespace)) return false;
    if (filters.pods.length && !filters.pods.includes(e.podName)) return false;
    if (filters.nodes.length && !filters.nodes.includes(e.nodeName)) return false;
    if (binaryLower && !e.binary.toLowerCase().includes(binaryLower)) return false;
    if (filters.inPod === true && !e.podName) return false;
    if (filters.inPod === false && e.podName) return false;
    if (timeActive) {
      // events without a usable timestamp cannot be placed in a time range
      if (!Number.isFinite(e.timeMs)) return false;
      if (e.timeMs < tStart || e.timeMs > tEnd) return false;
    }
    if (regex) {
      if (!regex.test(e.searchHay)) return false;
    }
    return true;
  });
}
