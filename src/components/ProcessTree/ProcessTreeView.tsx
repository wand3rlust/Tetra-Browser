import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useStore } from '../../store/events';
import { signalName } from '../../parser/normalize';
import { requestTree, requestTreeExport } from '../../workers/client';
import type { TreeData, TreeLine } from '../../workers/protocol';
import { downloadBlob } from '../../utils/export';
import './ProcessTree.css';

export default function ProcessTreeView() {
  const { filters, selectedEventIndex, selectEvent, dimensions } = useStore();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [podFilter, setPodFilter] = useState('');
  const [data, setData] = useState<TreeData | null>(null);
  const seededRef = useRef(false);

  // The tree is flattened inside the data worker (honoring the collapse
  // state, the pod filter and the event filters); we only receive the
  // visible window's lines.
  useEffect(() => {
    let stale = false;
    requestTree({
      filters,
      selectedEventIndex,
      podFilter,
      collapsed: [...collapsed],
      initial: !seededRef.current,
    }).then((d) => {
      if (stale) return;
      if (d.autoCollapsed && d.autoCollapsed.length) {
        // seed the collapse state so toggles behave consistently
        setCollapsed(new Set(d.autoCollapsed));
      }
      seededRef.current = true;
      setData(d);
    });
    return () => {
      stale = true;
    };
  }, [filters, selectedEventIndex, podFilter, collapsed]);

  const rows: TreeLine[] = data?.lines ?? [];

  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollEl,
    estimateSize: () => 30,
    overscan: 15,
    measureElement: (el) => el.getBoundingClientRect().height + 1,
  });

  const toggle = useCallback((execId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(execId)) next.delete(execId);
      else next.add(execId);
      return next;
    });
  }, []);

  const exportTree = async () => {
    const parts = await requestTreeExport(filters, podFilter, [...collapsed]);
    downloadBlob('tetra-process-tree.txt', new Blob(parts, { type: 'text/plain' }));
  };

  const pods = dimensions.pods;

  const collapsedCount = useMemo(() => collapsed.size, [collapsed]);

  return (
    <div className="pt-view">
      <div className="pt-toolbar">
        <span className="et-count">
          {data ? `${data.processCount.toLocaleString()} processes · ${data.rootCount.toLocaleString()} roots` : ''}
          {data?.truncated && (
            <span className="pt-truncated" title="collapse branches to see more of the tree">
              {' '}· showing first {rows.length.toLocaleString()} (truncated)
            </span>
          )}
        </span>
        <label className="pt-podfilter">
          Pod:{' '}
          <select value={podFilter} onChange={(e) => setPodFilter(e.target.value)}>
            <option value="">All</option>
            {pods.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </label>
        <button onClick={exportTree}>
          Export tree ↓
        </button>
      </div>

      <div className="pt-scroll" ref={setScrollEl}>
        {rows.length === 0 && (
          <div className="et-empty">No processes to display.</div>
        )}
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
          {virtualizer.getVirtualItems().map((vRow) => {
            const node = rows[vRow.index];
            const isCollapsed = collapsed.has(node.execId);
            const selected = node.selected;
            const onPath = node.onPath;
            const synthetic = node.synthetic;
            const hasEvents = node.execEventIndex !== null || node.exitEventIndex !== null || node.kprobeCount > 0;
            return (
              <div
                key={node.execId + vRow.key}
                data-index={vRow.index}
                ref={virtualizer.measureElement}
                className={`pt-row ${selected ? 'selected' : ''} ${onPath ? 'on-path' : ''}`}
                style={{ position: 'absolute', top: 0, transform: `translateY(${vRow.start}px)`, width: '100%', paddingLeft: 16 + node.depth * 18 }}
                onClick={() => {
                  if (node.execEventIndex !== null) selectEvent(node.execEventIndex);
                  else if (node.exitEventIndex !== null) selectEvent(node.exitEventIndex);
                  else if (node.firstHookIndex !== null) selectEvent(node.firstHookIndex);
                }}
              >
                {node.hasChildren ? (
                  <button
                    className="pt-toggle"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggle(node.execId);
                    }}
                  >
                    {isCollapsed ? '+' : '−'}
                  </button>
                ) : (
                  <span className="pt-toggle-spacer" />
                )}
                <span className="pt-binary mono">
                  {node.binary || '(unknown)'}
                  {synthetic && <span className="pt-synthetic" title="lineage reconstructed from ancestors snapshot; not directly observed in this log">†</span>}
                </span>
                {node.podName && <span className="pt-pod">{node.namespace ? `${node.namespace}/` : ''}{node.podName}</span>}
                {hasEvents && node.execEventIndex === null && node.exitEventIndex === null && (
                  <span className="pt-hooks" title="tracing-policy hook events">{node.kprobeCount} hook{node.kprobeCount > 1 ? 's' : ''}</span>
                )}
                {node.exitEventIndex !== null && (
                  <span className={`pt-exit ${node.exitStatus === 0 ? 'ok' : 'bad'}`}>
                    {node.exitStatus !== undefined
                      ? node.exitStatus === 0 ? 'exit 0' : `exit ${node.exitStatus}`
                      : node.exitSignal !== undefined ? signalName(node.exitSignal) : ''}
                  </span>
                )}
                <span className="pt-pid mono">pid {node.pid}</span>
                {node.arguments && <span className="pt-args mono" title={node.arguments}>{node.arguments}</span>}
              </div>
            );
          })}
        </div>
      </div>

      <div className="pt-legend">
        <span><span className="pt-synthetic">†</span> from ancestors snapshot (not observed in log)</span>
        <span>Click a process to select its event · <span className="pt-toggle-sample">−</span>/<span className="pt-toggle-sample">+</span> collapse{collapsedCount > 0 ? ` (${collapsedCount.toLocaleString()} collapsed)` : ''}</span>
      </div>
    </div>
  );
}
