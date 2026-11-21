#!/usr/bin/env node
/**
 * Generate a synthetic Tetragon NDJSON log for local scale testing.
 *
 * Usage:
 *   node scripts/gen-large-sample.mjs [eventCount] [outPath]
 *
 * Defaults: 1,000,000 events --> /tmp/tetra-large.jsonl
 */
import { createWriteStream } from 'node:fs';

const count = Number(process.argv[2] ?? 1_000_000);
const out = process.argv[3] ?? '/tmp/tetra-large.jsonl';

const NODES = ['demo-node-1', 'demo-node-2', 'demo-node-3', 'demo-node-4', 'demo-node-5'];
const NAMESPACES = ['default', 'production', 'staging', 'kube-system'];
const BINARIES = [
  '/usr/bin/python3', '/bin/sh', '/bin/bash', '/usr/bin/find', '/usr/bin/curl',
  '/usr/bin/wget', '/bin/ls', '/bin/cat', '/bin/grep', '/usr/bin/awk',
  '/usr/local/bin/node', '/usr/sbin/nginx', '/usr/bin/openssl', '/bin/tar',
  '/usr/bin/ssh', '/usr/bin/nc', '/usr/bin/perl', '/usr/bin/ruby',
  '/usr/local/bin/app-server', '/usr/bin/git',
];
const POLICIES = ['ptrace-policy', 'fs-watcher', 'net-egress', 'cred-change', 'proc-exec-log'];
const HOOKS = ['security_file_open', 'security_socket_connect', 'vfs_write', 'tcp_connect', 'cap_capable'];
const IMAGES = [
  'docker.io/demo/app:v1', 'docker.io/demo/app:v2', 'docker.io/demo/sidecar:v1',
  'docker.io/demo/worker:v3', 'docker.io/demo/nginx:v1',
];
const PODS_PER_NS = 60;

const t0 = Date.parse('2026-01-01T00:00:00Z');
const SPAN_MS = 6 * 60 * 60 * 1000; // 6 hours

const rand = (n) => Math.floor(Math.random() * n);
const pick = (arr) => arr[rand(arr.length)];

function execId(node, ktime, pid) {
  return Buffer.from(`${node}:${ktime}:${pid}`).toString('base64');
}

function processFor(node, pid, pod, binary) {
  const p = {
    exec_id: execId(node, t0 * 1e6 + rand(SPAN_MS * 1000), pid),
    pid,
    tid: pid,
    uid: rand(2) === 0 ? 0 : 33,
    cwd: '/opt/demo',
    binary,
    flags: 'execve clone',
    start_time: new Date(t0 + rand(SPAN_MS)).toISOString(),
  };
  if (pod) {
    p.pod = {
      namespace: pod.ns,
      name: pod.name,
      uid: `uid-${pod.ns}-${pod.idx}`,
      container: {
        id: `containerd://${pod.idx}${rand(1000)}`,
        name: pod.name,
        image: { id: pick(IMAGES), name: pick(IMAGES) },
        start_time: '2025-12-31T22:00:00Z',
      },
      workload: pod.name,
      workload_kind: 'Pod',
    };
  }
  return p;
}

function makeEvent(i) {
  const node = pick(NODES);
  const inPod = rand(10) < 8;
  const pod = inPod
    ? { ns: pick(NAMESPACES), name: `${pick(['app', 'worker', 'api', 'cron'])}-${rand(PODS_PER_NS)}`, idx: rand(PODS_PER_NS * 4) }
    : null;
  const pid = 1000 + rand(900000);
  const binary = pick(BINARIES);
  const time = new Date(t0 + Math.floor((i / count) * SPAN_MS) + rand(500)).toISOString();
  const proc = processFor(node, pid, pod, binary);

  const kindRoll = rand(10);
  if (kindRoll < 5) {
    return { process_exec: { process: proc }, node_name: node, time };
  }
  if (kindRoll < 9) {
    return {
      process_exit: { process: proc, status: rand(10) === 0 ? 1 : 0 },
      node_name: node,
      time,
    };
  }
  // tracing-policy hook event
  return {
    process_kprobe: {
      process: proc,
      function_name: pick(HOOKS),
      policy_name: pick(POLICIES),
      action: 'Post',
      args: [{ label: 'path', path_arg: { path: '/tmp/demo' } }],
    },
    node_name: node,
    time,
  };
}

const stream = createWriteStream(out, { flags: 'w' });
let written = 0;
const BATCH = 10000;

function writeBatch() {
  const lines = [];
  for (let n = 0; n < BATCH && written < count; n++, written++) {
    lines.push(JSON.stringify(makeEvent(written)));
  }
  const ok = stream.write(lines.length ? lines.join('\n') + '\n' : '');
  if (written < count) {
    if (ok) writeBatch();
    else stream.once('drain', writeBatch);
  } else {
    stream.end(() => {
      console.log(`wrote ${written.toLocaleString()} events to ${out}`);
    });
  }
}

writeBatch();
