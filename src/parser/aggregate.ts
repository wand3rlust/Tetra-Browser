/**
 * Single-pass aggregation over a filtered event list.
 *
 * Everything the dashboard renders (stat cards, timeline buckets, type /
 * exit distributions, top lists) plus the sorted match index is computed in
 * one sweep so the worker can answer a filter query without repeated O(n)
 * passes. Pure module that runs inside the data worker and in unit tests.
 */
import type { NormalizedEvent } from './normalize';
import { filterEvents, type Filters, type SortKey } from './filtering';

export interface Bucket {
  start: number;
  end: number;
  label: string;
  [type: string]: number | string;
}

export interface NameCount {
  name: string;
  count: number;
}

export interface Aggregates {
  /** total events in the loaded dataset */
  total: number;
  /** events matching the current filters */
  matchCount: number;
  podCount: number;
  namespaceCount: number;
  binaryCount: number;
  nodeCount: number;
  /** timeline buckets (empty when no matched event has a timestamp) */
  buckets: Bucket[];
  typeData: NameCount[];
  exitData: { name: string; value: number }[];
  topBinaries: NameCount[];
  topPods: NameCount[];
  topPolicies: NameCount[];
  topHooks: NameCount[];
  /** global event indexes of matched events, in sorted order */
  indexes: Uint32Array;
}

export const EMPTY_AGGREGATES: Aggregates = {
  total: 0,
  matchCount: 0,
  podCount: 0,
  namespaceCount: 0,
  binaryCount: 0,
  nodeCount: 0,
  buckets: [],
  typeData: [],
  exitData: [],
  topBinaries: [],
  topPods: [],
  topPolicies: [],
  topHooks: [],
  indexes: new Uint32Array(0),
};

const TIMELINE_BUCKETS = 40;
const TOP_LIMIT = 8;
const TYPE_LIMIT = 12;

function compareEvents(a: NormalizedEvent, b: NormalizedEvent, key: SortKey['key']): number {
  switch (key) {
    case 'time':
      return (a.timeMs || 0) - (b.timeMs || 0);
    case 'type':
      return a.type.localeCompare(b.type);
    case 'binary':
      return a.binary.localeCompare(b.binary);
    case 'pod':
      return (a.podName || '~').localeCompare(b.podName || '~');
    case 'node':
      return (a.nodeName || '~').localeCompare(b.nodeName || '~');
    case 'pid':
      return a.pid - b.pid;
    case 'status':
      return (a.exitStatus ?? -1) - (b.exitStatus ?? -1);
  }
}

/** Sort a filtered (already-copied) array in place according to the sort key. */
export function sortMatched(events: NormalizedEvent[], sort: SortKey): void {
  events.sort((a, b) => compareEvents(a, b, sort.key) * sort.dir);
}

export function timeBuckets(events: NormalizedEvent[], bucketMs: number, min: number, max: number): Bucket[] {
  const buckets: Bucket[] = [];
  const label = (t: number) => new Date(t).toISOString().slice(11, 19);
  for (let t = min; t < max; t += bucketMs) {
    buckets.push({ start: t, end: t + bucketMs, label: label(t), total: 0 });
  }
  if (buckets.length === 0 || buckets[buckets.length - 1].end < max) {
    // final (possibly partial) bucket; also covers the min === max degenerate case
    const start = buckets.length ? buckets[buckets.length - 1].end : min;
    buckets.push({ start, end: Math.max(max, start), label: label(start), total: 0 });
  }
  const idxOf = (t: number) => Math.min(buckets.length - 1, Math.max(0, Math.floor((t - min) / bucketMs)));
  for (const e of events) {
    if (!Number.isFinite(e.timeMs)) continue;
    buckets[idxOf(e.timeMs)][e.type] = ((buckets[idxOf(e.timeMs)][e.type] as number) ?? 0) + 1;
    buckets[idxOf(e.timeMs)].total = (buckets[idxOf(e.timeMs)].total as number) + 1;
  }
  return buckets;
}

function topN(m: Map<string, number>, limit = TOP_LIMIT): NameCount[] {
  return [...m.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

/** Compute everything the dashboard + event table need for one filter query. */
export function computeAggregates(events: NormalizedEvent[], filters: Filters, sort: SortKey): Aggregates {
  const matched = filterEvents(events, filters);
  sortMatched(matched, sort);

  const indexes = new Uint32Array(matched.length);
  const pods = new Set<string>();
  const namespaces = new Set<string>();
  const binaries = new Set<string>();
  const nodes = new Set<string>();
  const typeCounts = new Map<string, number>();
  const exitCounts = new Map<string, number>();
  const binaryCounts = new Map<string, number>();
  const podCounts = new Map<string, number>();
  const policyCounts = new Map<string, number>();
  const hookCounts = new Map<string, number>();
  let min = Infinity;
  let max = -Infinity;

  for (let i = 0; i < matched.length; i++) {
    const e = matched[i];
    indexes[i] = e.index;
    if (e.podName) {
      pods.add(e.podName);
      const key = e.namespace ? `${e.namespace}/${e.podName}` : e.podName;
      podCounts.set(key, (podCounts.get(key) ?? 0) + 1);
    }
    if (e.namespace) namespaces.add(e.namespace);
    if (e.binary) {
      binaries.add(e.binary);
      binaryCounts.set(e.binary, (binaryCounts.get(e.binary) ?? 0) + 1);
    }
    if (e.nodeName) nodes.add(e.nodeName);
    if (e.policyName) policyCounts.set(e.policyName, (policyCounts.get(e.policyName) ?? 0) + 1);
    if (e.functionName) hookCounts.set(e.functionName, (hookCounts.get(e.functionName) ?? 0) + 1);
    typeCounts.set(e.type, (typeCounts.get(e.type) ?? 0) + 1);
    if (e.type === 'process_exit') {
      const k = e.exitStatus === undefined ? 'unknown' : String(e.exitStatus);
      exitCounts.set(k, (exitCounts.get(k) ?? 0) + 1);
    }
    if (Number.isFinite(e.timeMs)) {
      if (e.timeMs < min) min = e.timeMs;
      if (e.timeMs > max) max = e.timeMs;
    }
  }

  const buckets =
    Number.isFinite(min) && Number.isFinite(max)
      ? timeBuckets(matched, Math.max((max - min) / TIMELINE_BUCKETS, 1), min, max)
      : [];

  return {
    total: events.length,
    matchCount: matched.length,
    podCount: pods.size,
    namespaceCount: namespaces.size,
    binaryCount: binaries.size,
    nodeCount: nodes.size,
    buckets,
    typeData: topN(typeCounts, TYPE_LIMIT),
    exitData: [...exitCounts.entries()]
      .map(([name, value]) => ({ name: `exit ${name}`, value }))
      .sort((a, b) => b.value - a.value),
    topBinaries: topN(binaryCounts),
    topPods: topN(podCounts),
    topPolicies: topN(policyCounts),
    topHooks: topN(hookCounts),
    indexes,
  };
}
