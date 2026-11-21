import { useState } from 'react';
import { useStore } from '../../store/events';
import type { KprobeArgument, Process, StackEntry } from './detailTypes';
import { formatTime, signalName, decodeExecId } from '../../parser/normalize';
import './EventDetail.css';

function Section({ title, children, defaultOpen = true }: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="ed-section">
      <button className="ed-section-head" onClick={() => setOpen(!open)}>
        <span className={`chev ${open ? 'open' : ''}`}>▸</span> {title}
      </button>
      {open && <div className="ed-section-body">{children}</div>}
    </div>
  );
}

function KV({ k, v, mono = false, title }: { k: string; v?: React.ReactNode; mono?: boolean; title?: string }) {
  if (v === undefined || v === null || v === '') return null;
  return (
    <div className="kv">
      <span className="kv-key">{k}</span>
      <span className={`kv-val ${mono ? 'mono' : ''}`} title={title}>{v}</span>
    </div>
  );
}

function CapBadges({ caps }: { caps?: string[] }) {
  if (!caps?.length) return null;
  return (
    <div className="cap-badges">
      {caps.map((c) => (
        <span key={c} className="cap">{c.replace(/^CAP_/, '').replace(/^DAC_/, 'DAC ')}</span>
      ))}
    </div>
  );
}

function ProcessBlock({ p, label }: { p?: Process; label?: string }) {
  if (!p) return null;
  const exec = decodeExecId(p.exec_id);
  return (
    <div className="proc-block">
      {label && <div className="proc-label">{label}</div>}
      <div className="proc-binary mono">
        {p.binary || '(unknown)'} {p.arguments && <span className="proc-args">{p.arguments}</span>}
      </div>
      <div className="kv-grid">
        <KV k="exec id" v={<span title={p.exec_id}>{exec.valid ? `#${exec.pid}` : p.exec_id}</span>} mono />
        <KV k="pid" v={p.pid} mono />
        {p.tid !== undefined && p.tid !== p.pid && <KV k="tid" v={p.tid} mono />}
        <KV k="uid" v={p.uid} mono />
        <KV k="auid" v={p.auid !== undefined ? (p.auid === 4294967295 ? 'unset' : p.auid) : undefined} mono />
        <KV k="cwd" v={p.cwd} mono />
        <KV k="start time" v={formatTime(p.start_time)} mono />
        <KV k="flags" v={p.flags} mono />
        {p.docker && <KV k="container id" v={p.docker} mono />}
        {p.in_init_tree !== undefined && (
          <KV k="in init tree" v={p.in_init_tree ? 'yes' : 'no'} />
        )}
      </div>
    </div>
  );
}

function PodBlock({ p }: { p?: Process }) {
  const pod = p?.pod;
  if (!pod) return null;
  const c = pod.container;
  return (
    <div className="kv-grid">
      <KV k="namespace" v={pod.namespace} />
      <KV k="pod" v={pod.name} mono />
      <KV k="workload" v={pod.workload ? `${pod.workload} (${pod.workload_kind ?? '?'})` : undefined} />
      {c && (
        <>
          <KV k="container" v={c.name} mono />
          <KV k="image" v={c.image?.name} mono />
          <KV k="container start" v={formatTime(c.start_time)} mono />
          <KV k="privileged" v={c.security_context?.privileged ? 'yes' : undefined} />
        </>
      )}
      {pod.pod_labels && (
        <div className="labels">
          {Object.entries(pod.pod_labels).map(([k, v]) => (
            <span key={k} className="label">
              <em>{k}</em>
              {v !== '' && <>= {v}</>}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function CapsBlock({ p }: { p?: Process }) {
  const caps = p?.cap;
  const creds = p?.process_credentials;
  if (!caps && !creds) return null;
  return (
    <div>
      {creds && (
        <div className="kv-grid">
          <KV k="euid" v={creds.euid} mono />
          <KV k="egid" v={creds.egid} mono />
          <KV k="suid" v={creds.suid} mono />
          <KV k="fsuid" v={creds.fsuid} mono />
        </div>
      )}
      <div className="caps-groups">
        {(['permitted', 'effective', 'inheritable'] as const).map((g) => (
          <div key={g} className="caps-group">
            <span className="caps-title">{g}</span>
            <CapBadges caps={caps?.[g]} />
          </div>
        ))}
      </div>
    </div>
  );
}

function AncestorChain({ ancestors }: { ancestors: Process[] }) {
  if (!ancestors.length) return <div className="ed-muted">No ancestor information.</div>;
  return (
    <div className="ancestor-chain">
      {ancestors.map((a: Process, i: number) => (
        <div key={i} className="ancestor mono" style={{ paddingLeft: i * 14 }}>
          <span className="ancestor-binary">{a.binary}</span>
          {a.arguments && <span className="ancestor-args">{a.arguments}</span>}
        </div>
      ))}
    </div>
  );
}

/** Render a KprobeArgument's typed payload. */
function ArgValue({ arg }: { arg: KprobeArgument }) {
  if (arg === null || arg === undefined) return <em>null</em>;
  if (typeof arg === 'object' && !isKprobeArgShape(arg)) {
    // generic object
    return <span className="mono">{JSON.stringify(arg)}</span>;
  }
  const a = arg as Record<string, unknown>;
  const keys = Object.keys(a).filter((k) => k !== 'label' && a[k] !== undefined && a[k] !== null);
  if (!keys.length) return <em>empty</em>;
  return (
    <span className="arg-value mono">
      {keys.map((k) => (
        <span key={k} className="arg-kv">
          <em>{k.replace(/_arg$/, '')}=</em>
          {typeof a[k] === 'object' ? JSON.stringify(a[k]) : String(a[k])}
        </span>
      ))}
    </span>
  );
}

function isKprobeArgShape(v: unknown): boolean {
  return typeof v === 'object' && v !== null;
}

function ArgsTable({ args, title }: { args?: KprobeArgument[]; title: string }) {
  if (!args?.length) return null;
  return (
    <div className="args-table">
      <div className="args-title">{title}</div>
      {args.map((a: KprobeArgument, i: number) => {
        const label = (a as Record<string, unknown>)?.label as string | undefined;
        return (
          <div key={i} className="arg-row">
            <span className="arg-label mono">{label ?? `arg${i}`}</span>
            <ArgValue arg={a} />
          </div>
        );
      })}
    </div>
  );
}

function StackTrace({ entries, title }: { entries?: StackEntry[]; title: string }) {
  if (!entries?.length) return null;
  return (
    <div className="stacktrace">
      <div className="args-title">{title}</div>
      {entries.map((s, i) => (
        <div key={i} className="stack-frame mono">
          {s.symbol ?? '?'} <span className="stack-loc">+0x{(s.offset ?? 0).toString(16)} @ 0x{(s.address ?? 0).toString(16)}{s.module ? ` (${s.module})` : ''}</span>
        </div>
      ))}
    </div>
  );
}

function RawJson({ data }: { data: unknown }) {
  const [copied, setCopied] = useState(false);
  const text = JSON.stringify(data, null, 2);
  return (
    <div className="raw-json">
      <button
        className="copy-btn"
        onClick={() => {
          navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          });
        }}
      >
        {copied ? 'copied ✓' : 'copy'}
      </button>
      <pre>{text}</pre>
    </div>
  );
}

export default function EventDetail() {
  const { selectedEventIndex, selectedDetail, selectEvent, setFilters } = useStore();
  const [showRaw, setShowRaw] = useState(false);

  if (selectedEventIndex === null) {
    return (
      <aside className="event-detail">
        <div className="ed-placeholder">
          Select an event to inspect its details.
        </div>
      </aside>
    );
  }

  if (!selectedDetail || selectedDetail.event.index !== selectedEventIndex) {
    return (
      <aside className="event-detail">
        <div className="ed-placeholder">Loading event…</div>
      </aside>
    );
  }

  const e = selectedDetail.event;
  const lineage = selectedDetail.lineage;

  const raw = (e.raw ?? {}) as Record<string, unknown>;
  const payload = (raw[e.type] ?? {}) as Record<string, unknown>;
  const proc = payload.process as Process | undefined;
  const parent = payload.parent as Process | undefined;
  const ancestors = (payload.ancestors as Process[] | undefined) ?? [];
  const kprobeArgs = (payload.args as KprobeArgument[] | undefined) ?? [];
  const returnArg = payload.return as KprobeArgument | undefined;
  const dataArgs = (payload.data as KprobeArgument[] | undefined) ?? [];
  const kStack = payload.kernel_stack_trace as StackEntry[] | undefined;
  const uStack = payload.user_stack_trace as StackEntry[] | undefined;
  const tags = (payload.tags as string[] | undefined) ?? [];

  return (
    <aside className="event-detail">
      <div className="ed-head">
        <span className={`badge type-${e.type}`}>{e.type}</span>
        <span className="ed-time mono">{formatTime(e.time)}</span>
      </div>

      {e.message && <div className="ed-message">{e.message}</div>}
      {tags.length > 0 && (
        <div className="ed-tags">
          {tags.map((t) => <span key={t} className="tag mono">{t}</span>)}
        </div>
      )}

      <Section title="Process">
        <ProcessBlock p={proc} />
      </Section>

      {(e.exitStatus !== undefined || e.exitSignal !== undefined || e.type === 'process_exit') && (
        <Section title="Exit">
          <div className="kv-grid">
            <KV k="status" v={e.exitStatus !== undefined ? (
              e.exitStatus === 0 ? <span className="ok">0 (success)</span> : <span className="bad">{e.exitStatus}</span>
            ) : undefined} />
            <KV k="signal" v={e.exitSignal !== undefined ? signalName(e.exitSignal) : undefined} />
            <KV k="exit time" v={formatTime(payload.time as string | undefined)} mono />
          </div>
        </Section>
      )}

      {e.functionName && (
        <Section title="Hook">
          <div className="kv-grid">
            <KV k="function" v={e.functionName} mono />
            <KV k="policy" v={e.policyName} mono />
            <KV k="action" v={e.action ? <span className={`action action-${e.action.toLowerCase()}`}>{e.action}</span> : undefined} />
          </div>
        </Section>
      )}

      {proc?.pod && (
        <Section title="Kubernetes">
          <PodBlock p={proc} />
        </Section>
      )}

      {(proc?.cap || proc?.process_credentials) && (
        <Section title="Credentials & Capabilities" defaultOpen={false}>
          <CapsBlock p={proc} />
        </Section>
      )}

      <Section title="Parent & Lineage">
        <ProcessBlock p={parent} label="immediate parent" />
        {ancestors.length > 0 && (
          <div className="lineage-sub">
            <div className="args-title">ancestors (snapshot)</div>
            <AncestorChain ancestors={ancestors} />
          </div>
        )}
        {lineage.length > 1 && (
          <div className="lineage-sub">
            <div className="args-title">reconstructed path</div>
            <div className="recon-path">
              {lineage.map((n, i) => (
                <span key={n.execId} className="recon-node">
                  {i > 0 && <span className="recon-arrow"> → </span>}
                  <span
                    className="recon-binary mono"
                    title={n.execId}
                    onClick={() => {
                      // jump to the exec event of this ancestor if present
                      if (n.execEventIndex !== null) selectEvent(n.execEventIndex);
                    }}
                  >
                    {n.binary || '(unknown)'}
                  </span>
                </span>
              ))}
            </div>
          </div>
        )}
      </Section>

      {(kprobeArgs.length > 0 || returnArg || dataArgs.length > 0) && (
        <Section title="Tracing Policy Data">
          <ArgsTable args={kprobeArgs} title="arguments" />
          {returnArg && <ArgsTable args={[returnArg]} title="return" />}
          <ArgsTable args={dataArgs} title="data" />
          <StackTrace entries={kStack} title="kernel stack" />
          <StackTrace entries={uStack} title="user stack" />
        </Section>
      )}

      <Section title="Envelope">
        <div className="kv-grid">
          <KV k="node" v={e.nodeName} mono />
          <KV k="cluster" v={e.clusterName} mono />
          {(raw.node_labels as Record<string, string> | undefined) && (
            <div className="labels">
              {Object.entries(raw.node_labels as Record<string, string>).map(([k, v]) => (
                <span key={k} className="label"><em>{k}</em>{v !== '' && <>= {v}</>}</span>
              ))}
            </div>
          )}
        </div>
      </Section>

      <div className="ed-actions-row">
        {e.podName && (
          <button className="link-btn" onClick={() => setFilters({ pods: [e.podName] })}>
            filter by this pod
          </button>
        )}
        {e.binary && (
          <button className="link-btn" onClick={() => setFilters({ binary: e.binary })}>
            filter by this binary
          </button>
        )}
        <button className="link-btn" onClick={() => setShowRaw(!showRaw)}>
          {showRaw ? 'hide raw JSON' : 'show raw JSON'}
        </button>
      </div>

      {showRaw && <RawJson data={e.raw} />}
    </aside>
  );
}
