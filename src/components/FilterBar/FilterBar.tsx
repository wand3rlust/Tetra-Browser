import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore, type Filters } from '../../store/events';
import { EVENT_TYPE_ORDER, type TetragonEventType } from '../../parser/types';
import './FilterBar.css';

const TYPE_LABELS: Partial<Record<TetragonEventType, string>> = {
  process_exec: 'exec',
  process_exit: 'exit',
  process_kprobe: 'kprobe',
  process_tracepoint: 'tracepoint',
  process_uprobe: 'uprobe',
  process_usdt: 'usdt',
  process_lsm: 'lsm',
  process_loader: 'loader',
  process_throttle: 'throttle',
  rate_limit_info: 'ratelimit',
  test: 'test',
};

function MultiSelect({ label, options, selected, onChange }: {
  label: string;
  options: string[];
  selected: string[];
  onChange: (v: string[]) => void;
}) {
  return (
    <label className="filter-item">
      <span className="filter-label">{label}</span>
      <select
        multiple={false}
        value={selected.length === 1 ? selected[0] : ''}
        onChange={(e) => onChange(e.target.value ? [e.target.value] : [])}
      >
        <option value="">All</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Debounced text input: updates the store after a short pause to avoid
 *  re-filtering a large event list on every keystroke. */
function DebouncedInput({ label, placeholder, value, onCommit, grow }: {
  label: string;
  placeholder: string;
  value: string;
  onCommit: (v: string) => void;
  grow?: boolean;
}) {
  const [text, setText] = useState(value);
  const timer = useRef<number | undefined>(undefined);

  // keep local text in sync when the filter is changed from elsewhere (e.g. dashboard)
  useEffect(() => {
    if (value !== text) {
      window.clearTimeout(timer.current);
      setText(value);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const handleChange = (v: string) => {
    setText(v);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => onCommit(v), 200);
  };

  return (
    <label className={`filter-item ${grow ? 'grow' : ''}`}>
      <span className="filter-label">{label}</span>
      <input
        placeholder={placeholder}
        value={text}
        onChange={(e) => handleChange(e.target.value)}
      />
    </label>
  );
}

export default function FilterBar() {
  const { dimensions, filters, setFilters, resetFilters } = useStore();
  const namespaces = dimensions.namespaces;
  const pods = dimensions.pods;
  const nodes = dimensions.nodes;
  const presentTypes = useMemo(
    () => dimensions.types.filter((t): t is TetragonEventType => EVENT_TYPE_ORDER.includes(t as TetragonEventType)),
    [dimensions.types]
  );

  const setList = (key: 'namespaces' | 'pods' | 'nodes') => (v: string[]) =>
    setFilters({ [key]: v } as Partial<Filters>);

  return (
    <div className="filter-bar">
      <div className="filter-chips">
        <span className="filter-label">Type</span>
        <button
          className={`chip ${filters.types.length === 0 ? 'all' : ''}`}
          onClick={() => setFilters({ types: [] })}
        >
          all
        </button>
        {presentTypes.map((t) => (
          <button
            key={t}
            className={`chip type-${t} ${filters.types.includes(t) ? 'active' : ''}`}
            onClick={() =>
              setFilters({
                types: filters.types.includes(t)
                  ? filters.types.filter((x) => x !== t)
                  : [...filters.types, t],
              })
            }
          >
            {TYPE_LABELS[t] ?? t}
          </button>
        ))}
      </div>

      <div className="filter-controls">
        <MultiSelect label="Namespace" options={namespaces} selected={filters.namespaces} onChange={setList('namespaces')} />
        <MultiSelect label="Pod" options={pods} selected={filters.pods} onChange={setList('pods')} />
        <MultiSelect label="Node" options={nodes} selected={filters.nodes} onChange={setList('nodes')} />

        <DebouncedInput
          label="Binary"
          placeholder="/usr/bin/…"
          value={filters.binary}
          onCommit={(v) => setFilters({ binary: v })}
        />

        <DebouncedInput
          label="Search"
          placeholder="regex across binary, args, pod, policy…"
          value={filters.search}
          onCommit={(v) => setFilters({ search: v })}
          grow
        />

        <label className="filter-item">
          <span className="filter-label">Context</span>
          <select
            value={filters.inPod === null ? '' : filters.inPod ? 'pod' : 'host'}
            onChange={(e) =>
              setFilters({ inPod: e.target.value === '' ? null : e.target.value === 'pod' })
            }
          >
            <option value="">All</option>
            <option value="pod">In pods</option>
            <option value="host">Host only</option>
          </select>
        </label>

        <button className="reset" onClick={resetFilters} title="Clear all filters">
          Reset
        </button>
      </div>
    </div>
  );
}
