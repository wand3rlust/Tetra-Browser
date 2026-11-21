import { describe, it, expect } from 'vitest';
import { filterEvents, emptyFilters } from './filtering';
import { normalizeEvent } from './normalize';
import type { TetragonEvent } from './types';

const T0 = Date.parse('2020-01-01T00:00:00Z');

function makeEvent(over: Partial<TetragonEvent> = {}, index = 0) {
  const base: TetragonEvent = {
    process_exec: {
      process: {
        exec_id: `node:1:${100 + index}`,
        pid: 100 + index,
        binary: '/bin/ls',
        arguments: '-la',
      },
    },
    node_name: 'node-1',
    time: new Date(T0 + index * 1000).toISOString(),
    ...over,
  };
  return normalizeEvent(base, index);
}

function events(n: number) {
  return Array.from({ length: n }, (_, i) => makeEvent({}, i));
}

describe('filterEvents: time range semantics', () => {
  it('keeps events within the inclusive bounds', () => {
    const evs = events(5); // T0, T0+1s, ... T0+4s
    const mid = evs[2].timeMs;
    const out = filterEvents(evs, { ...emptyFilters, timeRange: [mid, mid] });
    expect(out).toHaveLength(1);
    expect(out[0].index).toBe(2);
  });

  it('includes events exactly at the start and end of the range', () => {
    const evs = events(5);
    const out = filterEvents(evs, { ...emptyFilters, timeRange: [evs[0].timeMs, evs[4].timeMs] });
    expect(out).toHaveLength(5);
  });

  it('excludes events outside the range', () => {
    const evs = events(5);
    const out = filterEvents(evs, { ...emptyFilters, timeRange: [evs[1].timeMs, evs[2].timeMs] });
    expect(out.map((e) => e.index)).toEqual([1, 2]);
  });

  it('excludes events with invalid timestamps when a time range is active', () => {
    const evs = [makeEvent({}, 0), makeEvent({ time: undefined, process_exec: undefined, process_exit: { process: { exec_id: 'x:1:1', pid: 1 }, time: 'not-a-date' } } as Partial<TetragonEvent>, 1)];
    expect(Number.isFinite(evs[1].timeMs)).toBe(false);
    const out = filterEvents(evs, { ...emptyFilters, timeRange: [T0, T0 + 10_000] });
    expect(out.map((e) => e.index)).toEqual([0]);
  });

  it('keeps events with invalid timestamps when no time range is set', () => {
    const evs = [makeEvent({}, 0), makeEvent({ time: undefined, process_exec: undefined, process_exit: { process: { exec_id: 'x:1:1', pid: 1 }, time: 'not-a-date' } } as Partial<TetragonEvent>, 1)];
    const out = filterEvents(evs, emptyFilters);
    expect(out).toHaveLength(2);
  });
});

describe('filterEvents: other predicates', () => {
  it('matches binary case-insensitively as a substring', () => {
    const evs = [makeEvent(), makeEvent({ process_exec: { process: { exec_id: 'n:1:2', pid: 2, binary: '/usr/bin/python3' } } }, 1)];
    const out = filterEvents(evs, { ...emptyFilters, binary: 'PYTHON' });
    expect(out.map((e) => e.binary)).toEqual(['/usr/bin/python3']);
  });

  it('searches across binary, arguments and pod via the precomputed haystack', () => {
    const evs = [makeEvent(), makeEvent({ process_exec: { process: { exec_id: 'n:1:2', pid: 2, binary: '/bin/sh', arguments: 'curl evil.example.com', pod: { namespace: 'prod', name: 'web-1' } } } }, 1)];
    expect(filterEvents(evs, { ...emptyFilters, search: 'evil.example' })).toHaveLength(1);
    expect(filterEvents(evs, { ...emptyFilters, search: 'web-1' })).toHaveLength(1);
    expect(filterEvents(evs, { ...emptyFilters, search: '/bin' })).toHaveLength(2);
  });

  it('falls back to a literal match when the search is not a valid regex', () => {
    const evs = [makeEvent({ process_exec: { process: { exec_id: 'n:1:1', pid: 1, binary: '/bin/rm', arguments: '-rf [junk]' } } })];
    expect(filterEvents(evs, { ...emptyFilters, search: '[junk' })).toHaveLength(1);
  });

  it('applies type, namespace, pod and node filters', () => {
    const evs = [
      makeEvent(),
      makeEvent({ process_exec: { process: { exec_id: 'n:1:2', pid: 2, binary: '/bin/sh', pod: { namespace: 'prod', name: 'web-1' } } }, node_name: 'node-2' }, 1),
      makeEvent({ process_exec: undefined, process_exit: { process: { exec_id: 'n:1:3', pid: 3, binary: '/bin/true' } } }, 2),
    ];
    expect(filterEvents(evs, { ...emptyFilters, types: ['process_exit'] })).toHaveLength(1);
    expect(filterEvents(evs, { ...emptyFilters, namespaces: ['prod'] })).toHaveLength(1);
    expect(filterEvents(evs, { ...emptyFilters, pods: ['web-1'] })).toHaveLength(1);
    expect(filterEvents(evs, { ...emptyFilters, nodes: ['node-2'] })).toHaveLength(1);
    expect(filterEvents(evs, { ...emptyFilters, inPod: true })).toHaveLength(1);
    expect(filterEvents(evs, { ...emptyFilters, inPod: false })).toHaveLength(2);
  });
});
