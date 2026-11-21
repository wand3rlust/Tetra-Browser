/**
 * Lenient Tetragon log parser.
 *
 * Never throws on bad records: corrupt/truncated lines are skipped and
 * surfaced as warnings (with line numbers) so users know what was dropped.
 *
 * JSONL input is processed as a byte stream decoded in chunks, so files
 * larger than the maximum JavaScript string length (~500 MB) parse fine.
 * The file is never fully materialized as a single string. Pretty-printed
 * JSON arrays (which cannot be split by line) still require whole-file
 * decoding; oversized array files produce a warning suggesting JSONL.
 */
import type { TetragonEvent, TetragonEventType } from './types';
import { EVENT_TYPE_ORDER } from './types';
import { isGzip, ungzip } from './detect';

export interface ParseWarning {
  line: number; // 1-based line number; 0 for whole-file errors
  reason: string;
  excerpt: string; // first ~120 chars of the offending text
}

export interface ParseResult {
  events: TetragonEvent[];
  /** original JSON text of each accepted event, aligned with `events` */
  rawLines: string[];
  warnings: ParseWarning[];
  format: string;
  wasGzip: boolean;
}

export function getEventType(event: TetragonEvent): TetragonEventType | 'unknown' {
  for (const t of EVENT_TYPE_ORDER) {
    if (event[t] !== undefined) return t;
  }
  return 'unknown';
}

export function isValidEvent(event: unknown): event is TetragonEvent {
  return typeof event === 'object' && event !== null && getEventType(event as TetragonEvent) !== 'unknown';
}

const KUBECTL_PREFIX = /^\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?\s+(stderr|stdout)\s+\S?\s*/;

const EXCERPT_LEN = 120;

function excerpt(s: string): string {
  return s.slice(0, EXCERPT_LEN);
}

interface LineHandler {
  (event: TetragonEvent, line: number, rawText: string): void;
}

const DECODE_CHUNK = 1 << 24; // 16 MB

function decodeSlice(data: Uint8Array, start: number, end: number): string {
  return new TextDecoder('utf-8').decode(data.subarray(start, end));
}

/** Stream `data` through a TextDecoder, invoking cb once per complete line.
 *  Chunk boundaries are UTF-8 safe: the decoder buffers partial sequences. */
function forEachLine(data: Uint8Array, cb: (line: string) => void): void {
  const decoder = new TextDecoder('utf-8');
  let pending = '';
  for (let off = 0; off < data.length; off += DECODE_CHUNK) {
    const end = Math.min(off + DECODE_CHUNK, data.length);
    const chunk = decoder.decode(data.subarray(off, end), { stream: true });
    const lines = (pending + chunk).split('\n');
    pending = lines.pop() ?? '';
    for (const l of lines) cb(l);
  }
  const tail = pending + decoder.decode();
  if (tail.length) cb(tail);
}

function countLines(data: Uint8Array): number {
  let n = 1;
  let i = data.indexOf(0x0a);
  while (i !== -1) {
    n++;
    i = data.indexOf(0x0a, i + 1);
  }
  return n;
}

function detectFormat(data: Uint8Array): 'array' | 'jsonl' | 'kubectl-wrapped' {
  const head = decodeSlice(data, 0, Math.min(data.length, 1 << 16));
  if (head.trimStart().startsWith('[')) return 'array';
  // kubectl-wrapped: k8s log prefixes dominate the first lines
  const lines = head.split('\n').filter((l) => l.trim());
  let wrapped = 0;
  let plain = 0;
  for (const line of lines.slice(0, 20)) {
    if (KUBECTL_PREFIX.test(line)) wrapped++;
    else if (line.trim().startsWith('{')) plain++;
  }
  return wrapped > 0 && wrapped >= plain ? 'kubectl-wrapped' : 'jsonl';
}

function parseArray(text: string, onEvent: LineHandler, warnings: ParseWarning[]): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    warnings.push({ line: 0, reason: `JSON array parse failed: ${(e as Error).message}`, excerpt: excerpt(text) });
    return;
  }
  if (!Array.isArray(parsed)) {
    warnings.push({ line: 0, reason: 'Top-level JSON is not an array', excerpt: excerpt(text) });
    return;
  }
  parsed.forEach((item, i) => {
    if (isValidEvent(item)) onEvent(item, i + 1, JSON.stringify(item));
    else warnings.push({ line: i + 1, reason: 'Record is not a recognized Tetragon event', excerpt: excerpt(JSON.stringify(item)) });
  });
}

/** Parse one JSONL line (with kubectl-prefix stripping and start-truncation recovery). */
function parseJsonlLine(line: string, lineNo: number, wrapped: boolean, onEvent: LineHandler, warnings: ParseWarning[]): void {
  let l = line.trim();
  if (!l) return;
  if (wrapped) l = l.replace(KUBECTL_PREFIX, '').trim();
  if (!l) return;
  let event: unknown;
  let rawText = l;
  let recovered = false;
  try {
    event = JSON.parse(l);
  } catch {
    // tolerate lines truncated at the very start (observed in real exports,
    // e.g. a line missing its `{"` opening). Try progressively longer prefixes.
    const prefixes = ['{', '{"'];
    let ok = false;
    for (const p of prefixes) {
      try {
        rawText = p + l;
        event = JSON.parse(rawText);
        ok = true;
        recovered = true;
        break;
      } catch {
        // keep trying
      }
    }
    if (!ok) {
      warnings.push({ line: lineNo, reason: 'Malformed/truncated JSON line (skipped)', excerpt: excerpt(l) });
      return;
    }
  }
  if (isValidEvent(event)) {
    onEvent(event, lineNo, rawText);
    if (recovered) {
      warnings.push({ line: lineNo, reason: 'Truncated line start (auto-recovered)', excerpt: excerpt(l) });
    }
  } else {
    warnings.push({ line: lineNo, reason: 'Not a recognized Tetragon event', excerpt: excerpt(l) });
  }
}

/**
 * Parse a raw log file (possibly gzip-compressed) into events.
 * `onProgress` receives (processedLines, totalLines) for JSONL inputs.
 */
export function parseFile(
  bytes: Uint8Array,
  onProgress?: (processed: number, total: number) => void
): ParseResult {
  let data = bytes;
  let wasGzip = false;
  if (isGzip(data)) {
    data = new Uint8Array(ungzip(data));
    wasGzip = true;
  }

  const events: TetragonEvent[] = [];
  const rawLines: string[] = [];
  const warnings: ParseWarning[] = [];
  const onEvent: LineHandler = (event, _line, rawText) => {
    events.push(event);
    rawLines.push(rawText);
  };

  const format = detectFormat(data);

  if (format === 'array') {
    let text: string;
    try {
      text = new TextDecoder('utf-8').decode(data);
    } catch {
      warnings.push({
        line: 0,
        reason: 'File exceeds the maximum decodable string size (~500 MB); re-export as JSONL to load files this large',
        excerpt: '',
      });
      return { events, rawLines, warnings, format, wasGzip };
    }
    parseArray(text, onEvent, warnings);
  } else {
    const wrapped = format === 'kubectl-wrapped';
    const total = countLines(data);
    let processed = 0;
    let lineNo = 0;
    forEachLine(data, (line) => {
      lineNo++;
      parseJsonlLine(line, lineNo, wrapped, onEvent, warnings);
      processed++;
      if (onProgress && processed % 20000 === 0) onProgress(processed, total);
    });
    onProgress?.(total, total);
  }
  return { events, rawLines, warnings, format, wasGzip };
}
