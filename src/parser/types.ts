/**
 * TypeScript types mirroring Tetragon's
 * api/v1/tetragon/events.proto and tetragon.proto.
 *
 * These describe the JSON encoding produced by Tetragon's exporters
 * (export-stdout / tetragon.log) and the `tetra get-events -o json` CLI.
 * Unknown fields are intentionally preserved via raw event access.
 */

// ---------- Envelope ----------

export type TetragonEventType =
  | 'process_exec'
  | 'process_exit'
  | 'process_kprobe'
  | 'process_tracepoint'
  | 'process_loader'
  | 'process_uprobe'
  | 'process_throttle'
  | 'process_lsm'
  | 'process_usdt'
  | 'test'
  | 'rate_limit_info';

export const EVENT_TYPE_ORDER: TetragonEventType[] = [
  'process_exec',
  'process_exit',
  'process_kprobe',
  'process_tracepoint',
  'process_loader',
  'process_uprobe',
  'process_throttle',
  'process_lsm',
  'process_usdt',
  'test',
  'rate_limit_info',
];

/** Top-level event envelope. The event oneof plus common metadata fields. */
export interface TetragonEvent {
  // oneof event
  process_exec?: ProcessExec;
  process_exit?: ProcessExit;
  process_kprobe?: ProcessKprobe;
  process_tracepoint?: ProcessTracepoint;
  process_loader?: ProcessLoader;
  process_uprobe?: ProcessUprobe;
  process_throttle?: ProcessThrottle;
  process_lsm?: ProcessLsm;
  process_usdt?: ProcessUsdt;
  test?: TestEvent;
  rate_limit_info?: RateLimitInfo;
  // common metadata (field numbers >= 1000 in the proto)
  node_name?: string;
  time?: string; // RFC3339 timestamp
  cluster_name?: string;
  node_labels?: Record<string, string>;
}

export interface TestEvent {
  arg0?: number;
  arg1?: number;
  arg2?: number;
  arg3?: number;
}

export interface RateLimitInfo {
  number_of_dropped_process_events?: number;
}

// ---------- Kubernetes metadata ----------

export interface Image {
  id?: string;
  name?: string;
}

export interface SecurityContext {
  privileged?: boolean;
}

export interface Container {
  id?: string;
  name?: string;
  image?: Image;
  start_time?: string;
  pid?: number;
  maybe_exec_probe?: boolean;
  security_context?: SecurityContext;
}

export interface Pod {
  namespace?: string;
  name?: string;
  uid?: string;
  container?: Container;
  pod_labels?: Record<string, string>;
  workload?: string;
  workload_kind?: string;
  pod_annotations?: Record<string, string>;
}

// ---------- Process ----------

export interface Capabilities {
  permitted?: string[];
  effective?: string[];
  inheritable?: string[];
}

export interface Namespace {
  inum?: number;
  is_host?: boolean;
}

export interface Namespaces {
  uts?: Namespace;
  ipc?: Namespace;
  mnt?: Namespace;
  pid?: Namespace;
  pid_for_children?: Namespace;
  net?: Namespace;
  time?: Namespace;
  time_for_children?: Namespace;
  cgroup?: Namespace;
  user?: Namespace;
}

export interface UserNamespace {
  level?: number;
  uid?: number;
  gid?: number;
  ns?: Namespace;
}

export interface ProcessCredentials {
  uid?: number;
  gid?: number;
  euid?: number;
  egid?: number;
  suid?: number;
  sgid?: number;
  fsuid?: number;
  fsgid?: number;
  securebits?: string[];
  caps?: Capabilities;
  user_ns?: UserNamespace;
}

export interface InodeProperties {
  number?: number;
  links?: number;
}

export interface FileProperties {
  inode?: InodeProperties;
  path?: string;
}

export interface ProcessPrivilegesChanged {
  // e.g. uid change events
  [key: string]: unknown;
}

export interface BinaryProperties {
  setuid?: number;
  setgid?: number;
  privileges_changed?: ProcessPrivilegesChanged[];
  file?: FileProperties;
}

export interface UserRecord {
  name?: string;
}

export interface EnvVar {
  Key?: string;
  Value?: string;
}

export interface Process {
  exec_id?: string;
  pid?: number;
  uid?: number;
  cwd?: string;
  binary?: string;
  arguments?: string;
  flags?: string;
  start_time?: string;
  auid?: number;
  pod?: Pod;
  docker?: string;
  parent_exec_id?: string;
  refcnt?: number;
  cap?: Capabilities;
  ns?: Namespaces;
  tid?: number;
  process_credentials?: ProcessCredentials;
  binary_properties?: BinaryProperties;
  user?: UserRecord;
  in_init_tree?: boolean;
  environment_variables?: EnvVar[];
}

export interface ProcessExec {
  process?: Process;
  parent?: Process;
  ancestors?: Process[];
}

export interface ProcessExit {
  process?: Process;
  parent?: Process;
  signal?: string;
  status?: number;
  time?: string;
  ancestors?: Process[];
}

// ---------- Tracing policy events ----------

export interface KprobeSock {
  family?: string;
  type?: string;
  protocol?: string;
  mark?: number;
  priority?: number;
  saddr?: string;
  daddr?: string;
  sport?: number;
  dport?: number;
  cookie?: number;
  state?: string;
}

export interface KprobeSkb {
  hash?: number;
  len?: number;
  gso_size?: number;
  data?: string;
  timestamp?: string;
  firewall?: number;
}

export interface KprobeSockaddr {
  family?: number;
  addr?: string;
  port?: number;
}

export interface KprobeSockaddrUn {
  path?: string;
}

export interface KprobeNetDev {
  name?: string;
  address?: string;
  mtu?: number;
}

export interface KprobePath {
  mount_point?: string;
  path?: string;
  flags?: string;
  protocol?: string;
  operations?: number;
  device?: string;
  inode?: InodeProperties;
}

export interface KprobeFile {
  mount_point?: string;
  path?: string;
  flags?: string;
  mode?: number;
  inode?: InodeProperties;
}

export interface KprobeTruncatedBytes {
  orig_size?: number;
  size?: number;
  data?: string;
}

export interface KprobeCred {
  uid?: number;
  gid?: number;
  euid?: number;
  egid?: number;
  suid?: number;
  sgid?: number;
  fsuid?: number;
  fsgid?: number;
  securebits?: string[];
}

export interface KprobeLinuxBinprm {
  filename?: string;
  interpreter?: string;
  inode?: InodeProperties;
  cred_change?: boolean;
  ensure_unique_cred?: boolean;
}

export interface KprobeCapability {
  cap?: string;
}

export interface KprobeUserNamespace {
  level?: number;
  uid?: number;
  gid?: number;
  ns?: Namespace;
}

export interface KprobeBpfAttr {
  cmd?: string;
}

export interface KprobeBpfProg {
  id?: number;
  tag?: string;
  type?: string;
  name?: string;
  run_cnt?: number;
  run_time_ns?: number;
  average_run_time_ns?: number;
}

export interface KprobePerfEvent {
  type?: string;
  sample_period?: number;
  freq?: number;
}

export interface KprobeBpfMap {
  id?: number;
  type?: string;
  name?: string;
}

export interface KprobeError {
  errno?: number;
  message?: string;
}

export interface SyscallId {
  id?: number;
  name?: string;
}

/** Typed argument value of a kprobe/tracepoint/uprobe/LSM hook. */
export interface KprobeArgument {
  size_arg?: number;
  signed_arg?: number;
  int_arg?: number;
  long_arg?: number;
  uint_arg?: number;
  ulong_arg?: number;
  size_t_arg?: number;
  ssize_t_arg?: number;
  ptr_arg?: number;
  long_str_arg?: number;
  string_arg?: string;
  str_arg?: string;
  sock_arg?: KprobeSock;
  skb_arg?: KprobeSkb;
  sockaddr_arg?: KprobeSockaddr;
  sockaddr_un_arg?: KprobeSockaddrUn;
  net_dev_arg?: KprobeNetDev;
  path_arg?: KprobePath;
  file_arg?: KprobeFile;
  truncated_bytes_arg?: KprobeTruncatedBytes;
  cred_arg?: KprobeCred;
  linux_binprm_arg?: KprobeLinuxBinprm;
  capability_arg?: KprobeCapability;
  user_namespace_arg?: KprobeUserNamespace;
  bpf_attr_arg?: KprobeBpfAttr;
  bpf_prog_arg?: KprobeBpfProg;
  perf_event_arg?: KprobePerfEvent;
  bpf_map_arg?: KprobeBpfMap;
  syscall_arg?: SyscallId;
  error_arg?: KprobeError;
  time_hr_arg?: string;
  tcp_arg?: string;
  user_arg?: string;
  traffic_control_arg?: string;
  kernel_module_arg?: string;
  label?: string;
}

export interface StackTraceEntry {
  address?: number;
  offset?: number;
  symbol?: string;
  module?: string;
}

export interface ProcessKprobe {
  process?: Process;
  parent?: Process;
  function_name?: string;
  args?: KprobeArgument[];
  return?: KprobeArgument;
  action?: string;
  kernel_stack_trace?: StackTraceEntry[];
  policy_name?: string;
  return_action?: string;
  message?: string;
  tags?: string[];
  user_stack_trace?: StackTraceEntry[];
  ancestors?: Process[];
  data?: KprobeArgument[];
}

export interface ProcessTracepoint {
  process?: Process;
  parent?: Process;
  subsys?: string;
  event?: string;
  args?: KprobeArgument[];
  policy_name?: string;
  action?: string;
  message?: string;
  tags?: string[];
  ancestors?: Process[];
}

export interface ProcessUprobe {
  process?: Process;
  parent?: Process;
  path?: string;
  symbol?: string;
  policy_name?: string;
  message?: string;
  args?: KprobeArgument[];
  tags?: string[];
  ancestors?: Process[];
  offset?: number;
  ref_ctr_offset?: number;
  action?: string;
  data?: KprobeArgument[];
  user_stack_trace?: StackTraceEntry[];
}

export interface ProcessUsdt {
  process?: Process;
  parent?: Process;
  path?: string;
  provider?: string;
  name?: string;
  policy_name?: string;
  message?: string;
  args?: KprobeArgument[];
  tags?: string[];
  ancestors?: Process[];
  action?: string;
  flags?: string;
}

export interface ProcessLsm {
  process?: Process;
  parent?: Process;
  function_name?: string;
  policy_name?: string;
  message?: string;
  args?: KprobeArgument[];
  action?: string;
  tags?: string[];
  ancestors?: Process[];
  ima_hash?: string;
}

export interface ProcessLoader {
  process?: Process;
  parent?: Process;
  symbols?: Array<{
    name?: string;
    address?: number;
    type?: string;
  }>;
  time?: string;
}

export interface ProcessThrottle {
  type?: 'THROTTLE_UNKNOWN' | 'THROTTLE_START' | 'THROTTLE_STOP';
  cgroup?: string;
}
