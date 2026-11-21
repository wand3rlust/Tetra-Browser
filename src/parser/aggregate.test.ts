import { describe, it, expect } from 'vitest';
import { computeAggregates, timeBuckets, EMPTY_AGGREGATES } from './aggregate';
import { normalizeAll } from './normalize';
import { emptyFilters, defaultSort, type SortKey } from './filtering';
import type { TetragonEvent } from './types';

const T0 = Date.parse('2020-01-01T00:00:00Z');

function rawEvents(n: number): TetragonEvent[] {
  return Array.from({ length: n }, (_, i) => ({
    process_exec: {
      process: {
        exec_id: `node-1:1:${100 + i}`,
        pid: 100 + i,
        binary: i % 2 ? '/usr/bin/python3' : '/bin/sh',
        arguments: '-la',
        pod: { namespace: 'prod', name: i < 4 ? 'web-1' : `web-${i}` },
      },
    },
    node_name: 'node-1',
    time: new Date(T0 + i * 1000).toISOString(),
  }));
}

const events = normalizeAll(rawEvents(10));

describe('timeBuckets', () => {
  it('creates buckets covering the range with end boundaries', () => {
    const evs = events.slice(0, 3); // T0, T0+1s, T0+2s
    const min = T0;
    const max = T0 + 2000;
    const buckets = timeBuckets(evs, 1000, min, max);
    expect(buckets.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < buckets.length; i++) {
      expect(buckets[i].start).toBe(buckets[i - 1].end);
    }
    expect(buckets[buckets.length - 1].end).toBeGreaterThanOrEqual(max);
    // every finite-time event lands in some bucket's total
    const total = buckets.reduce((n, b) => n + (b.total as number), 0);
    expect(total).toBe(3);
  });

  it('handles the degenerate min === max case', () => {
    const buckets = timeBuckets([events[0]], 1, T0, T0);
    expect(buckets).toHaveLength(1);
    expect(buckets[0].start).toBe(T0);
    expect((buckets[0].total as number)).toBe(1);
  });
});

describe('computeAggregates', () => {
  it('computes counts, sorted indexes and top lists in one pass', () => {
    const agg = computeAggregates(events, emptyFilters, defaultSort);
    expect(agg.total).toBe(10);
    expect(agg.matchCount).toBe(10);
    expect(agg.podCount).toBe(7); // web-1 (x4 collapsed) + web-4..web-9
    expect(agg.binaryCount).toBe(2);
    expect(agg.typeData.find((t) => t.name === 'process_exec')?.count).toBe(10);
    expect(agg.topBinaries[0].name).toBe('/bin/sh');
    expect(agg.topBinaries[0].count).toBe(5);
    // sorted by time ascending --> indexes in original order
    expect(Array.from(agg.indexes)).toEqual([...Array(10).keys()]);
    // every matched event has a valid global index into the events array
    for (const idx of agg.indexes) expect(events[idx]).toBeDefined();
  });

  it('respects filters and sort direction', () => {
    const desc: SortKey = { key: 'time', dir: -1 };
    const agg = computeAggregates(events, { ...emptyFilters, pods: ['web-1'] }, desc);
    expect(agg.matchCount).toBe(4);
    expect(Array.from(agg.indexes)).toEqual([3, 2, 1, 0]);
    expect(agg.podCount).toBe(1);
  });

  it('produces bucket boundaries that select exactly their own events when used as a time range', () => {
    const agg = computeAggregates(events, emptyFilters, defaultSort);
    const b = agg.buckets[0];
    const inRange = events.filter(
      (e) => Number.isFinite(e.timeMs) && e.timeMs >= b.start && e.timeMs <= b.end
    );
    expect(inRange.length).toBe(b.total as number);
    // filtering by the clicked bucket keeps exactly that bucket's events
    const clicked = computeAggregates(events, { ...emptyFilters, timeRange: [b.start, b.end] }, defaultSort);
    expect(clicked.matchCount).toBe(b.total as number);
  });

  it('returns empty aggregates for an empty dataset', () => {
    const agg = computeAggregates([], emptyFilters, defaultSort);
    expect(agg.matchCount).toBe(0);
    expect(agg.buckets).toEqual([]);
    expect(agg.indexes).toEqual(new Uint32Array(0));
    expect(agg).toEqual(EMPTY_AGGREGATES);
  });
});
