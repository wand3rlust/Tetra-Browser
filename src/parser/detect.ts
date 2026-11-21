/**
 * Input format helpers for Tetragon log files.
 *
 * Gzip input (detected via magic bytes 0x1f 0x8b) is decompressed with pako
 * before parsing; see parse.ts for format detection and streaming.
 */
import { ungzip } from 'pako';

export function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

export { ungzip };
