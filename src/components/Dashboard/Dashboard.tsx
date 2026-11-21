import { BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer, PieChart, Pie, Cell, Cell as BarCell } from 'recharts';
import { useStore } from '../../store/events';
import { formatBytes } from '../../parser/normalize';
import type { Bucket } from '../../parser/aggregate';
import './Dashboard.css';

const TYPE_COLORS: Record<string, string> = {
  process_exec: '#42d5e0',
  process_exit: '#6b7689',
  process_kprobe: '#b48ef5',
  process_tracepoint: '#f5a542',
  process_uprobe: '#3fd68f',
  process_usdt: '#3fd68f',
  process_lsm: '#f4596b',
  process_loader: '#42d5e0',
  process_throttle: '#e8d44d',
  rate_limit_info: '#e8d44d',
};

const PIE_COLORS = ['#4f9cf7', '#42d5e0', '#b48ef5', '#3fd68f', '#f5a542', '#f4596b', '#e8d44d', '#6b7689'];

function TopList({ title, items, onSelect }: {
  title: string;
  items: { name: string; count: number }[];
  onSelect?: (name: string) => void;
}) {
  const max = items[0]?.count ?? 1;
  return (
    <div className="card top-list">
      <h3>{title}</h3>
      {items.length === 0 && <div className="card-empty">no data</div>}
      {items.map((i) => (
        <div
          key={i.name}
          className={`top-row ${onSelect ? 'clickable' : ''}`}
          onClick={() => onSelect?.(i.name)}
          title={onSelect ? `filter by ${i.name}` : i.name}
        >
          <span className="top-name mono">{i.name}</span>
          <span className="top-bar-wrap">
            <span className="top-bar" style={{ width: `${(i.count / max) * 100}%` }} />
          </span>
          <span className="top-count">{i.count.toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
}

export default function Dashboard() {
  const { files, eventCount, matchCount, aggregates, setFilters, filters } = useStore();
  const { buckets, typeData, exitData, topBinaries, topPods, topPolicies, topHooks, podCount, namespaceCount, binaryCount, nodeCount } = aggregates;

  /** Resolve the clicked bucket from the chart click state, robust to duplicate labels. */
  const bucketFromClick = (state: unknown): Bucket | undefined => {
    const s = state as { activePayload?: { payload?: unknown }[]; activeIndex?: number; activeLabel?: unknown } | null;
    const fromPayload = s?.activePayload?.[0]?.payload;
    if (fromPayload && typeof fromPayload === 'object' && 'start' in (fromPayload as Bucket)) {
      return fromPayload as Bucket;
    }
    if (typeof s?.activeIndex === 'number' && buckets[s.activeIndex]) return buckets[s.activeIndex];
    if (s?.activeLabel !== undefined) return buckets.find((x) => x.label === s.activeLabel);
    return undefined;
  };

  const clearTimeRange = () => setFilters({ timeRange: null });
  const isFiltered = matchCount !== eventCount;

  return (
    <div className="dashboard">
      <div className="stat-cards">
        <div className="stat-card">
          <span className="stat-value">{matchCount.toLocaleString()}</span>
          <span className="stat-label">events {isFiltered && <em>(of {eventCount.toLocaleString()})</em>}</span>
        </div>
        <div className="stat-card">
          <span className="stat-value">{podCount.toLocaleString()}</span>
          <span className="stat-label">pods</span>
        </div>
        <div className="stat-card">
          <span className="stat-value">{namespaceCount.toLocaleString()}</span>
          <span className="stat-label">namespaces</span>
        </div>
        <div className="stat-card">
          <span className="stat-value">{binaryCount.toLocaleString()}</span>
          <span className="stat-label">binaries</span>
        </div>
        <div className="stat-card">
          <span className="stat-value">{nodeCount.toLocaleString()}</span>
          <span className="stat-label">nodes</span>
        </div>
        <div className="stat-card">
          <span className="stat-value">{formatBytes(files.reduce((n, f) => n + f.size, 0))}</span>
          <span className="stat-label">log size</span>
        </div>
      </div>

      <div className="card chart-card timeline-card">
        <h3>
          Events over time
          {filters.timeRange && (
            <button className="clear-range" onClick={clearTimeRange}>× clear time filter</button>
          )}
          <span className="timeline-hint">Click a bar to time-filter around it.</span>
        </h3>
        <div className="chart-box chart-box--tall">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={buckets}
              onClick={(state) => {
                const b = bucketFromClick(state);
                if (b) setFilters({ timeRange: [b.start, b.end] });
              }}
            >
              <CartesianGrid stroke="#2a3140" strokeDasharray="3 3" />
              <XAxis dataKey="label" tick={{ fill: '#6b7689', fontSize: 10 }} />
              <YAxis tick={{ fill: '#6b7689', fontSize: 10 }} width={40} />
              <Tooltip
                contentStyle={{ background: '#171c26', border: '1px solid #2a3140', borderRadius: 8 }}
                labelStyle={{ color: '#a8b3c5' }}
              />
              {typeData.map((t, i) => (
                <Bar key={t.name} dataKey={t.name} stackId="1" fill={TYPE_COLORS[t.name] ?? PIE_COLORS[i % PIE_COLORS.length]} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="card chart-card">
        <h3>By event type</h3>
        <div className="chart-box">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={typeData.map((t) => ({ name: t.name, value: t.count }))}
                dataKey="value"
                nameKey="name"
                innerRadius={45}
                outerRadius={80}
                paddingAngle={2}
              >
                {typeData.map((t, i) => (
                  <Cell key={t.name} fill={TYPE_COLORS[t.name] ?? PIE_COLORS[i % PIE_COLORS.length]} />
                ))}
              </Pie>
              <Tooltip
                contentStyle={{ background: '#171c26', border: '1px solid #2a3140', borderRadius: 8 }}
              />
            </PieChart>
          </ResponsiveContainer>
        </div>
        <div className="legend-row">
          {typeData.map((t, i) => (
            <span key={t.name} className="legend-item">
              <span className="dot" style={{ background: TYPE_COLORS[t.name] ?? PIE_COLORS[i % PIE_COLORS.length] }} />
              {t.name.replace('process_', '')} ({t.count.toLocaleString()})
            </span>
          ))}
        </div>
      </div>

      <div className="card chart-card">
        <h3>Exit status distribution</h3>
        {exitData.length === 0 ? (
          <div className="card-empty">no exit events</div>
        ) : (
          <div className="chart-box">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={exitData} layout="vertical">
                <CartesianGrid stroke="#2a3140" strokeDasharray="3 3" horizontal={false} />
                <XAxis type="number" tick={{ fill: '#6b7689', fontSize: 10 }} />
                <YAxis type="category" dataKey="name" tick={{ fill: '#6b7689', fontSize: 10 }} width={70} />
                <Tooltip contentStyle={{ background: '#171c26', border: '1px solid #2a3140', borderRadius: 8 }} />
                <Bar dataKey="value" radius={[0, 4, 4, 0]}>
                  {exitData.map((d) => (
                    <BarCell key={d.name} fill={d.name === 'exit 0' ? '#3fd68f' : d.name.startsWith('exit unknown') ? '#6b7689' : '#f4596b'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      <TopList
        title="Top binaries"
        items={topBinaries}
        onSelect={(name) => setFilters({ binary: filters.binary === name ? '' : name })}
      />
      <TopList
        title="Top pods"
        items={topPods}
        onSelect={(name) => {
          const sep = name.indexOf('/');
          const ns = sep === -1 ? '' : name.slice(0, sep);
          const pod = sep === -1 ? name : name.slice(sep + 1);
          setFilters({ pods: [pod], namespaces: ns ? [ns] : [] });
        }}
      />
      <TopList title="Top policies" items={topPolicies} />
      <TopList title="Top hook functions" items={topHooks} />

      {files.some((f) => f.warnings.length > 0) && (
        <div className="card warnings-card">
          <h3>Parse warnings ({files.reduce((n, f) => n + f.warnings.length, 0)})</h3>
          {files.flatMap((f) =>
            f.warnings.map((w, i) => (
              <div key={`${f.name}-${i}`} className="warning-row mono">
                <span className="warn-file">{f.name}</span>
                <span className="warn-line">line {w.line}</span>
                <span className="warn-reason">{w.reason}</span>
                <span className="warn-excerpt" title={w.excerpt}>{w.excerpt.slice(0, 80)}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
