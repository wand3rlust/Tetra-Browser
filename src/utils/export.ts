/** CSV/JSON export helpers. Serialization of large result sets runs in the
 *  data worker; the main thread only assembles the chunks into a Blob. */

function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export const CSV_COLUMNS = [
  'time',
  'type',
  'node',
  'namespace',
  'pod',
  'container',
  'image',
  'pid',
  'binary',
  'arguments',
  'cwd',
  'flags',
  'parent_binary',
  'exit_status',
  'function_name',
  'policy_name',
  'action',
  'exec_id',
] as const;

export function csvHeader(): string {
  return CSV_COLUMNS.join(',');
}

export function csvRow(r: Record<string, unknown>): string {
  return CSV_COLUMNS.map((c) => csvEscape(r[c])).join(',');
}

export function eventsToCsv(rows: Record<string, unknown>[]): string {
  return rows.length ? `${csvHeader()}\n${rows.map(csvRow).join('\n')}` : csvHeader();
}

export function downloadBlob(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function downloadFile(name: string, content: string, mime = 'text/plain'): void {
  downloadBlob(name, new Blob([content], { type: mime }));
}
