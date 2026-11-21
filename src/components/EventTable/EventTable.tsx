import { useRef, useState, useEffect, useCallback } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useStore } from '../../store/events';
import type { SortKey } from '../../store/events';
import { formatTimeShort, signalName } from '../../parser/normalize';
import { requestRows, requestExport } from '../../workers/client';
import type { EventRow } from '../../workers/protocol';
import { downloadBlob } from '../../utils/export';
import './EventTable.css';

const TYPE_BADGE: Record<string, string> = {
  process_exec: 'exec',
  process_exit: 'exit',
  process_kprobe: 'kprobe',
  process_tracepoint: 'tracept',
  process_uprobe: 'uprobe',
  process_usdt: 'usdt',
  process_lsm: 'lsm',
  process_loader: 'loader',
  process_throttle: 'throttle',
  rate_limit_info: 'ratelim',
  test: 'test',
};

/** Row cache is shared across queries: rows are per-event, only the order changes. */
const ROW_CACHE_LIMIT = 50000;

export default function EventTable() {
  const { selectedEventIndex, selectEvent, filters, sort, setSort, matchCount, aggregates } = useStore();
  const parentRef = useRef<HTMLDivElement>(null);
  const rowsCache = useRef(new Map<number, EventRow>());
  const pending = useRef(new Set<number>());
  const [, setTick] = useState(0);

  const indexes = aggregates.indexes;

  const virtualizer = useVirtualizer({
    count: matchCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 32,
    overscan: 12,
  });

  // Fetch the row objects for whatever slice of the (sorted, filtered) match
  // list is currently visible. Runs after every render; the pending set
  // deduplicates in-flight requests, so repeated runs are cheap no-ops.
  useEffect(() => {
    const items = virtualizer.getVirtualItems();
    const missing: number[] = [];
    for (const it of items) {
      const eventIndex = indexes[it.index];
      if (eventIndex === undefined) continue;
      if (!rowsCache.current.has(eventIndex) && !pending.current.has(eventIndex)) missing.push(eventIndex);
    }
    if (!missing.length) return;
    for (const m of missing) pending.current.add(m);
    requestRows(missing).then((rows) => {
      if (rowsCache.current.size > ROW_CACHE_LIMIT) rowsCache.current.clear();
      for (const r of rows) {
        rowsCache.current.set(r.index, r);
        pending.current.delete(r.index);
      }
      setTick((t) => t + 1);
    });
  });

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (selectedEventIndex === null) return;
      const pos = indexes.indexOf(selectedEventIndex);
      if (pos === -1) return;
      let next = pos;
      if (e.key === 'ArrowDown') next = Math.min(pos + 1, matchCount - 1);
      else if (e.key === 'ArrowUp') next = Math.max(pos - 1, 0);
      else return;
      e.preventDefault();
      const nextIndex = indexes[next];
      if (nextIndex !== undefined) selectEvent(nextIndex);
      virtualizer.scrollToIndex(next);
    },
    [selectedEventIndex, indexes, matchCount, selectEvent, virtualizer]
  );

  useEffect(() => {
    const el = parentRef.current;
    if (el) el.tabIndex = 0;
  }, []);

  const toggleSort = (key: SortKey['key']) =>
    setSort(sort.key === key ? { key, dir: (sort.dir * -1) as 1 | -1 } : { key, dir: 1 });

  const exportCsv = async () => {
    const parts = await requestExport('csv', filters, sort);
    downloadBlob('tetra-events.csv', new Blob(parts, { type: 'text/csv' }));
  };

  const exportJson = async () => {
    const parts = await requestExport('json', filters, sort);
    downloadBlob('tetra-events.json', new Blob(parts, { type: 'application/json' }));
  };

  const showTimeRange = filters.timeRange !== null;

  const SortHeader = ({ k, label, className }: { k: SortKey['key']; label: string; className?: string }) => (
    <div className={`et-col-head ${className ?? ''} ${sort.key === k ? 'sorted' : ''}`} onClick={() => toggleSort(k)}>
      {label}
      <span className="sort-arrow">{sort.key === k ? (sort.dir === 1 ? '▲' : '▼') : ''}</span>
    </div>
  );

  return (
    <div className="event-table-wrap">
      <div className="et-toolbar">
        <span className="et-count">
          {matchCount.toLocaleString()} event{matchCount === 1 ? '' : 's'}
          {showTimeRange && ' (time-filtered)'}
        </span>
        <div className="et-actions">
          <button onClick={exportCsv} title="Export filtered events as CSV">Export CSV ↓</button>
          <button onClick={exportJson} title="Export filtered events as JSON">Export JSON ↓</button>
        </div>
      </div>
      <div
        className="et-body"
        ref={parentRef}
        onKeyDown={handleKeyDown}
        role="grid"
        aria-label="Event list"
      >
        <div className="et-inner">
          <div className="et-header">
            <SortHeader k="time" label="Time" className="c-time" />
            <SortHeader k="type" label="Type" className="c-type" />
            <SortHeader k="pid" label="PID" className="c-pid" />
            <SortHeader k="binary" label="Process" className="c-proc" />
            <SortHeader k="pod" label="Pod" className="c-pod" />
            <SortHeader k="node" label="Node" className="c-node" />
            <SortHeader k="status" label="Exit" className="c-exit" />
          </div>
          {matchCount === 0 && (
            <div className="et-empty">No events match the current filters.</div>
          )}
          <div className="et-rows" style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
            {virtualizer.getVirtualItems().map((vRow) => {
              const eventIndex = indexes[vRow.index];
              const e = eventIndex !== undefined ? rowsCache.current.get(eventIndex) : undefined;
              const selected = eventIndex === selectedEventIndex;
              return (
                <div
                  key={`${eventIndex}-${vRow.key}`}
                  className={`et-row ${selected ? 'selected' : ''} ${e ? '' : 'loading'}`}
                  style={{ position: 'absolute', top: vRow.start, height: vRow.size, width: '100%' }}
                  onClick={() => eventIndex !== undefined && selectEvent(eventIndex)}
                >
                  {e ? (
                    <>
                      <div className="et-cell c-time mono" title={e.time}>{formatTimeShort(e.time)}</div>
                      <div className="et-cell c-type">
                        <span className={`badge type-${e.type}`}>{TYPE_BADGE[e.type] ?? e.type}</span>
                        {e.type !== 'process_exec' && e.type !== 'process_exit' && e.functionName && (
                          <span className="fn mono" title={e.functionName}>{e.functionName}</span>
                        )}
                      </div>
                      <div className="et-cell c-pid mono">{e.pid || ''}</div>
                      <div className="et-cell c-proc">
                        <span className="binary mono">{e.binary || '(unknown)'}</span>
                        {e.arguments && <span className="args mono" title={e.arguments}>{e.arguments}</span>}
                      </div>
                      <div className="et-cell c-pod">
                        {e.podName ? (
                          <>
                            <span className="ns">{e.namespace}/</span>
                            {e.podName}
                          </>
                        ) : (
                          <span className="host">host</span>
                        )}
                      </div>
                      <div className="et-cell c-node">{e.nodeName}</div>
                      <div className="et-cell c-exit mono">
                        {e.exitStatus !== undefined &&
                          (e.exitStatus === 0 ? (
                            <span className="ok">0</span>
                          ) : (
                            <span className="bad">{e.exitStatus}</span>
                          ))}
                        {e.exitSignal !== undefined && (
                          <span className="sig" title="terminated by signal">{signalName(e.exitSignal)}</span>
                        )}
                        {e.action && e.type !== 'process_exec' && e.type !== 'process_exit' && (
                          <span className={`action action-${e.action.toLowerCase()}`}>{e.action}</span>
                        )}
                      </div>
                    </>
                  ) : (
                    <div className="et-cell et-skeleton" />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
