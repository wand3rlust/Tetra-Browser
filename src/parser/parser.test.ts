import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { gzip } from 'pako';
import { parseFile, getEventType } from './parse';
import { normalizeAll, decodeExecId } from './normalize';
import { buildProcessTree, lineagePath } from './processTree';
import type { TetragonEvent } from './types';

const read = (path: string) => new TextEncoder().encode(readFileSync(path, 'utf-8'));

const SAMPLES = [
  'public/samples/tetra_sample_1.jsonl',
  'public/samples/tetra_sample_2.json',
  'public/samples/tetra_sample_3.json',
].map((n) => new URL(`../../${n}`, import.meta.url).pathname);

describe('format detection and parsing', () => {
  it('parses sample 1 (JSONL) cleanly', () => {
    const result = parseFile(read(SAMPLES[0]));
    expect(result.format).toBe('jsonl');
    expect(result.wasGzip).toBe(false);
    expect(result.events).toHaveLength(20);
    expect(result.warnings).toHaveLength(0);
    const types = result.events.map(getEventType);
    expect(types.filter((t) => t === 'process_exec')).toHaveLength(9);
    expect(types.filter((t) => t === 'process_exit')).toHaveLength(11);
  });

  it('auto-recovers a JSONL line truncated at the start, with a warning', () => {
    const full = JSON.stringify({
      process_exec: {
        process: { exec_id: 'demo', binary: '/bin/ls' },
      },
      node_name: 'node-1',
      time: '2020-01-01T00:00:00Z',
    });
    const text = `${full.slice(2)}\n`; // line missing its `{"` opening
    const result = parseFile(new TextEncoder().encode(text));
    expect(result.format).toBe('jsonl');
    expect(result.events).toHaveLength(1);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].reason).toMatch(/Truncated line start \(auto-recovered\)/);
    expect(result.warnings[0].line).toBe(1);
  });

  it('parses sample 2 (pretty-printed JSON array)', () => {
    const result = parseFile(read(SAMPLES[1]));
    expect(result.format).toBe('array');
    expect(result.events).toHaveLength(15);
    expect(result.warnings).toHaveLength(0);
    const types = result.events.map(getEventType);
    expect(types.filter((t) => t === 'process_exec')).toHaveLength(2);
    expect(types.filter((t) => t === 'process_exit')).toHaveLength(13);
  });

  it('parses sample 3 (pretty-printed JSON array)', () => {
    const result = parseFile(read(SAMPLES[2]));
    expect(result.format).toBe('array');
    expect(result.events).toHaveLength(9);
    expect(result.warnings).toHaveLength(0);
  });

  it('transparently decompresses gzip input', () => {
    const gzipped = gzip(read(SAMPLES[1]));
    const result = parseFile(new Uint8Array(gzipped));
    expect(result.wasGzip).toBe(true);
    expect(result.events).toHaveLength(15);
  });

  it('strips kubectl-log line prefixes', () => {
    const raw = JSON.stringify({
      process_exec: {
        process: { exec_id: 'bm9kZToxMjM0NTY3ODo0Mg==', pid: 42, binary: '/bin/ls', arguments: '-la' },
      },
      node_name: 'node-1',
      time: '2020-01-01T00:00:00Z',
    });
    const text = `2020-01-01T00:00:00.123456789Z stderr F ${raw}\n`;
    const result = parseFile(new TextEncoder().encode(text));
    expect(result.format).toBe('kubectl-wrapped');
    expect(result.events).toHaveLength(1);
    expect(result.events[0].process_exec?.process?.binary).toBe('/bin/ls');
  });

  it('skips garbage lines with warnings instead of failing', () => {
    const text = 'this is not json\n{"process_throttle":{"type":"THROTTLE_START"}}\n';
    const result = parseFile(new TextEncoder().encode(text));
    expect(result.events).toHaveLength(1);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].line).toBe(1);
  });
});

describe('sample anonymization audit', () => {
  it('contains no CVE references, real-world dates, or private pod IPs', () => {
    for (const path of SAMPLES) {
      const text = readFileSync(path, 'utf-8');
      expect(text).not.toMatch(/cve[-_]?\d{4}[-_]\d+/i);
      // all timestamps sit in November 2026 (the neutral month used for the samples)
      for (const m of text.matchAll(/"(\d{4})-(\d{2})-\d{2}T/g)) {
        expect(`${m[1]}-${m[2]}`).toBe('2026-11');
      }
      // private IPs must be mapped to TEST-NET-1 (192.0.2.0/24); 0.0.0.0 allowed
      for (const m of text.matchAll(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g)) {
        const ip = m[0];
        const isTestNet = ip.startsWith('192.0.2.');
        const isWildcard = ip === '0.0.0.0';
        expect(isTestNet || isWildcard, `unexpected IP in sample: ${ip}`).toBe(true);
      }
    }
  });

  it('uses demo entity names', () => {
    const s1 = parseFile(read(SAMPLES[0]));
    const normalized = normalizeAll(s1.events);
    const pods = new Set(normalized.map((e) => e.podName).filter(Boolean));
    for (const pod of pods) expect(pod).toMatch(/^demo-app-\d+$/);
    const nodes = new Set(normalized.map((e) => e.nodeName).filter(Boolean));
    for (const node of nodes) expect(node).toMatch(/^demo-node-\d+$|^demo-control-plane$/);
    const images = new Set(normalized.map((e) => e.image).filter(Boolean));
    for (const img of images) expect(img).toMatch(/^docker\.io\/demo\/app-\d+:v1$|^docker\.io\/demo\/base:v1$/);
  });
});

describe('normalization', () => {
  it('normalizes all three samples without loss', () => {
    for (const path of SAMPLES) {
      const { events } = parseFile(read(path));
      const normalized = normalizeAll(events);
      expect(normalized).toHaveLength(events.length);
      for (const n of normalized) {
        expect(n.index).toBeGreaterThanOrEqual(0);
        expect(n.type).not.toBe('unknown');
      }
    }
  });

  it('decodes exec_id payloads (anonymized node names)', () => {
    const { events } = parseFile(read(SAMPLES[0]));
    const normalized = normalizeAll(events);
    const hostname = normalized.find((e) => e.binary === '/usr/bin/hostname');
    const info = decodeExecId(hostname?.execId);
    expect(info.valid).toBe(true);
    expect(info.node).toBe('demo-node-1');
    expect(info.pid).toBe(605122);
  });

  it('extracts exit signal, pod context and arguments from sample 2', () => {
    const { events } = parseFile(read(SAMPLES[1]));
    const normalized = normalizeAll(events);
    // sample 2 exits are signal-terminated (SIGABRT/SIGSEGV), no numeric status
    const exits = normalized.filter((e) => e.type === 'process_exit');
    const withSignal = exits.filter((e) => e.exitSignal);
    expect(withSignal.length).toBe(4);
    expect(withSignal.every((e) => e.exitSignal === 'SIGABRT' || e.exitSignal === 'SIGSEGV')).toBe(true);
    // sample 1 has one exit carrying a numeric status
    const s1 = normalizeAll(parseFile(read(SAMPLES[0])).events);
    const withStatus = s1.filter((e) => e.exitStatus !== undefined);
    expect(withStatus).toHaveLength(1);
    expect(withStatus[0].exitStatus).toBe(15);
    const podEvent = normalized.find((e) => e.podName);
    expect(podEvent?.namespace).toBe('default');
    expect(podEvent?.podName).toMatch(/demo-app-\d+/);
    expect(podEvent?.image).toContain('docker.io/demo/');
  });
});

describe('process tree reconstruction', () => {
  it('links exec events to parents via exec_id on sample 1', () => {
    const { events } = parseFile(read(SAMPLES[0]));
    const normalized = normalizeAll(events);
    const tree = buildProcessTree(normalized);
    // hostname (pid 605122) was spawned by /bin/sh -c '(id; hostname) > /tmp/pwned ...'
    const hostname = [...tree.byExecId.values()].find((n) => n.binary === '/usr/bin/hostname');
    expect(hostname).toBeDefined();
    expect(hostname!.pid).toBe(605122);
    const parent = hostname!.parent ? tree.byExecId.get(hostname!.parent) : undefined;
    expect(parent?.binary).toBe('/bin/sh');
    expect(parent?.arguments).toContain('hostname');
    // /usr/bin/cat /tmp/pwned descends from bash whose parent is the containerd-shim
    const cat = [...tree.byExecId.values()].find((n) => n.binary === '/usr/bin/cat');
    expect(cat).toBeDefined();
    const catPath = lineagePath(tree.byExecId, cat!.execId).map((n) => n.binary);
    expect(catPath).toContain('/bin/bash');
    expect(catPath).toContain('/usr/local/bin/containerd-shim-runc-v2');
    // the runc exec chain (runc -> init) also links up
    const init = [...tree.byExecId.values()].find((n) => n.binary === '/proc/self/fd/7');
    expect(init).toBeDefined();
    expect(tree.byExecId.get(init!.parent!)?.binary).toBe('/usr/local/sbin/runc');
  });

  it('correlates exec and exit events on the same node', () => {
    const { events } = parseFile(read(SAMPLES[0]));
    const normalized = normalizeAll(events);
    const tree = buildProcessTree(normalized);
    const withBoth = [...tree.byExecId.values()].filter(
      (n) => n.execEventIndex !== null && n.exitEventIndex !== null
    );
    expect(withBoth.length).toBeGreaterThan(0);
  });
});

describe('tracing policy (kprobe) events', () => {
  const kprobeEvent: TetragonEvent = {
    process_kprobe: {
      process: {
        exec_id: 'bm9kZToxMDA6MTAwMA==',
        pid: 1000,
        binary: '/bin/bash',
        pod: { namespace: 'default', name: 'test-pod' },
        parent_exec_id: 'bm9kZToxOjE=',
      },
      function_name: 'security_file_open',
      args: [{ label: 'path', file_arg: { path: '/etc/passwd', flags: 'O_RDONLY' } }],
      action: 'Post',
      policy_name: 'file-monitoring',
      tags: ['example'],
    },
    node_name: 'node-1',
    time: '2020-01-01T00:00:00Z',
  };

  it('parses, normalizes and links a synthetic kprobe event', () => {
    const result = parseFile(
      new TextEncoder().encode(`${JSON.stringify(kprobeEvent)}\n`)
    );
    expect(result.events).toHaveLength(1);
    expect(getEventType(result.events[0])).toBe('process_kprobe');
    const [normalized] = normalizeAll(result.events);
    expect(normalized.type).toBe('process_kprobe');
    expect(normalized.functionName).toBe('security_file_open');
    expect(normalized.policyName).toBe('file-monitoring');
    expect(normalized.action).toBe('Post');
    expect(normalized.execId).toBe('bm9kZToxMDA6MTAwMA==');
    const tree = buildProcessTree([normalized]);
    const node = tree.byExecId.get('bm9kZToxMDA6MTAwMA==');
    expect(node).toBeDefined();
    expect(node!.kprobeEventIndexes).toHaveLength(1);
  });
});
