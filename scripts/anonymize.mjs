#!/usr/bin/env node
/**
 * Anonymize Tetragon JSON log samples for public distribution.
 *
 * Pattern-based and data-driven, it works in two passes:
 *
 *   1. Collect: harvest entity strings from the data itself (node names,
 *      pod/container names, namespaces, image names, hex IDs, UIDs, tokens,
 *      earliest timestamp) and assign deterministic fake replacements.
 *   2. Scrub: walk every event, rewriting fields and free-text strings via
 *      the collected maps plus generic regex rules (timestamps, IPs, CVE
 *      references, home/opt paths, token arguments).
 *
 * Output is format-preserving: JSONL in --> JSONL out (including reproducing
 * the observed truncated first line, which exercises the lenient parser),
 * JSON array in --> pretty-printed array out. All timestamps are shifted by a
 * constant whole-second offset so the earliest lands on 2026-11-01 UTC;
 * intervals, ordering and nanosecond precision are preserved. Because the
 * shift is constant, a log that spans more than a month runs into December.
 *
 * Usage:
 *   node scripts/anonymize.mjs <input.json>... -o <output-dir>
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------- utils

const sha = (s) => createHash('sha256').update(s).digest('hex');
const fakeHex = (orig, len) => sha(`tetra-browser-anon:${orig}`).slice(0, len);

const fakeUuid = (orig) => {
  const h = sha(`tetra-browser-anon-uuid:${orig}`);
  const c = h.slice(0, 32).split('');
  c[12] = '4'; // version 4
  c[16] = '89ab'[parseInt(h[16], 16) % 4]; // RFC 4122 variant
  return [
    c.slice(0, 8).join(''),
    c.slice(8, 12).join(''),
    c.slice(12, 16).join(''),
    c.slice(16, 20).join(''),
    c.slice(20, 32).join(''),
  ].join('-');
};

const TARGET_EPOCH_SECONDS = Math.floor(Date.UTC(2026, 10, 1) / 1000);

const ISO_TS_RE = /(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z)?/g;
const ISO_TS_EXEC_RE = /(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z)?/;
const PRIVATE_IP_RE = /(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})/g;
const HEX64_RE = /[0-9a-f]{64}/g;
const CVE_REF_RE = /cve[-_]?\d{4}[-_]\d+/gi;
const LABEL_DOMAIN_RE = /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}\//;
const WHITELISTED_LABEL_DOMAINS = new Set([
  'kubernetes.io/',
  'beta.kubernetes.io/',
  'app.kubernetes.io/',
  'helm.sh/',
  'node-role.kubernetes.io/',
  'node.kubernetes.io/',
]);
// words that are generic and must never be treated as identifying tokens
const STOPWORDS = new Set([
  'node', 'sensor', 'debug', 'test', 'cluster', 'control', 'plane', 'worker',
  'ubuntu', 'system', 'demo', 'lib', 'log', 'var', 'app', 'www', 'test',
  'entrypoint', 'docker',
]);
const OPT_KEEP = new Set(['usr', 'etc', 'var', 'bin', 'lib', 'share', 'local', 'demo']);

// ---------------------------------------------------------------- state

class Counter {
  constructor() { this.n = 0; }
  next() { this.n += 1; return this.n; }
}

export class Anonymizer {
  constructor() {
    this.nodeMap = new Map(); // node name -> fake
    this.podMap = new Map(); // pod/container/workload name -> fake
    this.nsMap = new Map(); // namespace -> fake
    this.imgMap = new Map(); // image name -> fake
    this.imgRepoMap = new Map(); // image repo part (before :tag) -> fake repo
    this.hex64Map = new Map(); // 64-hex string -> fake
    this.dockerHexMap = new Map(); // docker-field hex (any len >= 8) -> fake
    this.uuidMap = new Map(); // uuid -> fake
    this.tokenMap = new Map(); // identifying word tokens -> fake
    this.cveMap = new Map(); // stray cve references -> fake
    this.ipMap = new Map(); // private IP -> TEST-NET
    this.cNode = new Counter();
    this.cPod = new Counter();
    this.cNs = new Counter();
    this.cImg = new Counter();
    this.cTok = new Counter();
    this.cCve = new Counter();
    this.cIp = new Counter();
    this.minTsSeconds = Infinity;
    this.offsetSeconds = 0;
    this.stats = { fieldsReplaced: 0, stringsScrubbed: 0 };
    this._orderedPairs = null;
  }

  // -------------------------------------------------------------- pass 1

  collectFromEvents(events) {
    for (const ev of events) {
      if (ev?.node_name) this.collectNode(ev.node_name);
      this.collectTs(ev.time);
      const payload = ev?.process_exec ?? ev?.process_exit ?? ev?.process_kprobe ??
        ev?.process_tracepoint ?? ev?.process_uprobe ?? ev?.process_usdt ??
        ev?.process_lsm ?? ev?.process_loader ?? null;
      if (payload) this.collectPayload(payload);
      this.collectLabels(ev?.node_labels);
    }
  }

  collectPayload(payload) {
    const processes = [];
    if (payload.process) processes.push(payload.process);
    if (payload.parent) processes.push(payload.parent);
    if (Array.isArray(payload.ancestors)) processes.push(...payload.ancestors);
    this.collectTs(payload.time);
    for (const p of processes) {
      if (!p) continue;
      this.collectTs(p.start_time);
      if (typeof p.docker === 'string' && p.docker.length >= 8) this.collectDockerHex(p.docker);
      const pod = p.pod;
      if (pod) {
        if (pod.name) this.collectPodName(pod.name);
        if (pod.workload) this.collectPodName(pod.workload);
        if (pod.namespace) this.collectNamespace(pod.namespace);
        if (pod.uid) this.uuidMap.set(pod.uid, fakeUuid(pod.uid));
        const c = pod.container;
        if (c) {
          if (c.name) this.collectPodName(c.name);
          if (c.start_time) this.collectTs(c.start_time);
          if (typeof c.id === 'string') for (const m of c.id.matchAll(HEX64_RE)) this.collectHex64(m[0]);
          if (c.image) {
            if (c.image.name) this.collectImage(c.image.name);
            if (c.image.id) for (const m of c.image.id.matchAll(HEX64_RE)) this.collectHex64(m[0]);
          }
        }
        this.collectLabels(pod.pod_labels);
      }
      // collect hex ids hiding in free text
      for (const fld of ['binary', 'arguments', 'cwd']) {
        if (typeof p[fld] === 'string') for (const m of p[fld].matchAll(HEX64_RE)) this.collectHex64(m[0]);
      }
    }
  }

  collectLabels(labels) {
    if (!labels || typeof labels !== 'object') return;
    this.labelDomainMap = this.labelDomainMap ?? new Map();
    this.vendorLabelKeys = this.vendorLabelKeys ?? new Set();
    for (const [k, v] of Object.entries(labels)) {
      if (LABEL_DOMAIN_RE.test(k) && ![...WHITELISTED_LABEL_DOMAINS].some((d) => k.startsWith(d))) {
        this.labelDomainMap.set(k, `demo.example.com/${k.split('/').slice(1).join('/')}`);
        this.vendorLabelKeys.add(k); // values under vendor-domain keys are replaced wholesale
      }
      if (typeof v === 'string') {
        for (const m of v.matchAll(HEX64_RE)) this.collectHex64(m[0]);
      }
    }
  }

  collectNode(name) {
    if (!this.nodeMap.has(name)) {
      const fake = /control-plane/i.test(name) ? 'demo-control-plane' : `demo-node-${this.cNode.next()}`;
      this.nodeMap.set(name, fake);
      this.minTsHint(name);
    }
  }

  minTsHint() { /* node names don't hold timestamps */ }

  collectPodName(name) {
    if (!this.podMap.has(name)) {
      this.podMap.set(name, `demo-app-${this.cPod.next()}`);
      this.collectTokensFromName(name);
    }
  }

  /** Extract identifying product-word tokens from collected names. */
  collectTokensFromName(name) {
    const parts = name.split('-');
    for (const part of parts) {
      // only alphabetic tokens of decent length that aren't generic words
      if (part.length >= 4 && /^[a-z][a-z0-9]*$/i.test(part) && !STOPWORDS.has(part.toLowerCase())) {
        if (!this.tokenMap.has(part)) this.tokenMap.set(part, `demo-${this.cTok.next()}`);
      }
    }
  }

  collectNamespace(ns) {
    if (ns !== 'default' && !this.nsMap.has(ns)) this.nsMap.set(ns, `demo-system-${this.cNs.next()}`);
  }

  collectImage(name) {
    if (!this.imgMap.has(name)) {
      const fake = `docker.io/demo/app-${this.cImg.next()}:v1`;
      this.imgMap.set(name, fake);
      // register the repo part too, so image IDs ("repo@sha256:...") are covered
      const repo = name.split('@')[0].split(':')[0];
      this.imgRepoMap.set(repo, fake.split(':')[0]);
    }
  }

  collectHex64(h) {
    if (!this.hex64Map.has(h)) this.hex64Map.set(h, fakeHex(`hex64:${h}`, 64));
  }

  collectDockerHex(h) {
    if (!this.dockerHexMap.has(h)) this.dockerHexMap.set(h, fakeHex(`dockerhex:${h}`, h.length));
  }

  collectTs(ts) {
    if (typeof ts !== 'string') return;
    const m = ISO_TS_EXEC_RE.exec(ts);
    if (!m) return;
    const [, y, mo, d, h, mi, s] = m;
    const sec = Math.floor(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s) / 1000);
    if (Number.isFinite(sec) && sec < this.minTsSeconds) this.minTsSeconds = sec;
  }

  finalizeOffset() {
    if (!Number.isFinite(this.minTsSeconds)) this.minTsSeconds = TARGET_EPOCH_SECONDS;
    this.offsetSeconds = TARGET_EPOCH_SECONDS - this.minTsSeconds;
  }

  // -------------------------------------------------------------- pass 2

  /** All substring replacements, longest key first, so longer strings
   *  (64-hex, full names) win over shorter prefixes. */
  orderedPairs() {
    if (this._orderedPairs) return this._orderedPairs;
    const all = [
      ...this.hex64Map,
      ...this.dockerHexMap,
      ...this.uuidMap,
      ...this.nodeMap,
      ...this.podMap,
      ...this.imgMap,
      ...this.imgRepoMap,
      ...this.nsMap,
      ...this.tokenMap,
      ...this.labelDomainMap ?? [],
    ];
    this._orderedPairs = all.sort((a, b) => b[0].length - a[0].length);
    return this._orderedPairs;
  }

  shiftTs(match, y, mo, d, h, mi, s, frac, zulu) {
    const sec = Math.floor(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s) / 1000) + this.offsetSeconds;
    const base = new Date(sec * 1000).toISOString().slice(0, 19);
    return `${base}${frac ?? ''}${zulu ?? ''}`;
  }

  scrubString(s) {
    if (typeof s !== 'string' || s === '') return s;
    this.stats.stringsScrubbed += 1;
    let r = s;
    for (const [orig, fake] of this.orderedPairs()) {
      if (r.includes(orig)) r = r.split(orig).join(fake);
    }
    // timestamps (constant whole-second shift keeps the fraction untouched)
    r = r.replace(ISO_TS_RE, this.shiftTs.bind(this));
    // private IPs -> TEST-NET-1 (deterministic per address); 0.0.0.0 kept
    r = r.replace(PRIVATE_IP_RE, (ip) => {
      if (ip === '0.0.0.0') return ip;
      if (!this.ipMap.has(ip)) this.ipMap.set(ip, `192.0.2.${this.cIp.next()}`);
      return this.ipMap.get(ip);
    });
    // stray CVE references (e.g. cve_2026_103041.py in arguments)
    r = r.replace(CVE_REF_RE, (m) => {
      if (!this.cveMap.has(m)) this.cveMap.set(m, `demo-issue-${this.cCve.next()}`);
      return this.cveMap.get(m);
    });
    // non-generic directories directly under /opt and /home (case-insensitive)
    r = r.replace(/\/opt\/([a-zA-Z0-9_.-]+)/g, (m, p) => (OPT_KEEP.has(p.toLowerCase()) ? m : '/opt/demo'));
    r = r.replace(/\/home\/([a-zA-Z0-9_.-]+)/g, (m, p) => (p.toLowerCase() === 'user' ? m : '/home/user'));
    // token argument values
    r = r.replace(/--token\s+('(?:[^']|\\')*'|"(?:[^"]|\\")*"|\S+)/g, '--token ***');
    return r;
  }

  scrubExecId(execId) {
    if (typeof execId !== 'string' || execId === '') return execId;
    try {
      const decoded = Buffer.from(execId, 'base64').toString('utf-8');
      const colon = decoded.indexOf(':');
      if (colon === -1) return this.scrubString(execId);
      const node = decoded.slice(0, colon);
      const rest = decoded.slice(colon);
      let fakeNode = this.nodeMap.get(node);
      if (!fakeNode && node !== '') {
        // defensive: map unknown hosts on the fly so nothing leaks via exec ids
        fakeNode = /control-plane/i.test(node) ? 'demo-control-plane' : `demo-node-${this.cNode.next()}`;
        this.nodeMap.set(node, fakeNode);
      }
      return Buffer.from((fakeNode ?? node) + rest, 'utf-8').toString('base64');
    } catch {
      return this.scrubString(execId);
    }
  }

  scrubValue(v, key, inLabels) {
    if (typeof v === 'string') {
      if (key === 'exec_id' || key === 'parent_exec_id') return this.scrubExecId(v);
      return this.scrubString(v);
    }
    if (Array.isArray(v)) return v.map((item) => this.scrubValue(item, key, inLabels));
    if (v && typeof v === 'object') return this.scrubObject(v, inLabels);
    return v;
  }

  scrubObject(obj, inLabels = false) {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      let key = k;
      let vendorValue = false;
      if (inLabels && this.labelDomainMap?.has(k)) {
        key = this.labelDomainMap.get(k);
        vendorValue = this.vendorLabelKeys?.has(k) ?? false;
      }
      out[key] =
        vendorValue && typeof v === 'string'
          ? 'demo' // vendor-domain label values never survive
          : this.scrubValue(v, k, inLabels || k === 'pod_labels' || k === 'node_labels');
    }
    return out;
  }

  scrubEvents(events) {
    this.finalizeOffset();
    return events.map((ev) => {
      this.stats.fieldsReplaced += 1;
      return this.scrubObject(ev);
    });
  }
}

// ---------------------------------------------------------------- io

function parseInput(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith('[')) {
    return { format: 'array', events: JSON.parse(trimmed) };
  }
  const events = [];
  let truncatedFirstLine = false;
  const lines = trimmed.split('\n');
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (!line) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // recover lines truncated at the start (missing leading '{' or '{"')
      const recovered = ['{', '{"'].map((p) => p + line).find((cand) => {
        try { JSON.parse(cand); return true; } catch { return false; }
      });
      if (recovered !== undefined) {
        events.push(JSON.parse(recovered));
        if (i === 0) truncatedFirstLine = true;
      }
    }
  }
  return { format: 'jsonl', events, truncatedFirstLine };
}

function serialize(events, format, truncateFirst) {
  if (format === 'array') {
    return `${JSON.stringify(events, null, 2)}\n`;
  }
  const lines = events.map((e) => JSON.stringify(e));
  if (truncateFirst && lines.length > 0) {
    // reproduce the observed real-world truncation on the first line so the
    // lenient-parser recovery path (and its test) stays meaningful
    lines[0] = lines[0].slice(2);
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------- cli

function main() {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('-o') !== -1 ? args.indexOf('-o') : args.indexOf('--out');
  if (args.length < 2 || outIdx === -1 || outIdx + 1 >= args.length) {
    console.error('Usage: node scripts/anonymize.mjs <input.json>... -o <output-dir>');
    process.exit(1);
  }
  const inputs = args.slice(0, outIdx);
  const outDir = args[outIdx + 1];

  const anonymizer = new Anonymizer();
  const parsedInputs = [];
  for (const path of inputs) {
    const text = readFileSync(path, 'utf-8');
    const parsed = parseInput(text);
    parsedInputs.push({ path, ...parsed });
    anonymizer.collectFromEvents(parsed.events);
  }

  mkdirSync(outDir, { recursive: true });
  const reports = [];
  for (const { path, format, events, truncatedFirstLine } of parsedInputs) {
    const scrubbed = anonymizer.scrubEvents(events);
    const outPath = join(outDir, path.split('/').pop());
    writeFileSync(outPath, serialize(scrubbed, format, truncatedFirstLine));
    reports.push(`${path} -> ${outPath} (${format}, ${scrubbed.length} events)`);
  }

  console.log(reports.join('\n'));
  console.error(`entity maps: nodes=${anonymizer.nodeMap.size} pods=${anonymizer.podMap.size} ` +
    `namespaces=${anonymizer.nsMap.size} images=${anonymizer.imgMap.size} hex64=${anonymizer.hex64Map.size} ` +
    `docker=${anonymizer.dockerHexMap.size} uuids=${anonymizer.uuidMap.size} tokens=${anonymizer.tokenMap.size} ` +
    `cves=${anonymizer.cveMap.size} ips=${anonymizer.ipMap.size}`);
  console.error(`timestamp shift: ${anonymizer.offsetSeconds}s (earliest -> 2026-11-01Z)`);
}

main();
