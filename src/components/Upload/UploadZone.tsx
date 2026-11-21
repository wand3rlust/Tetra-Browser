import { useCallback, useRef, useState } from 'react';
import { useStore } from '../../store/events';
import { parseFiles } from '../../workers/client';
import './Upload.css';

export default function UploadZone() {
  const { loading, error, progress, setData, setLoading, setError } = useStore();
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFiles = useCallback(
    async (files: File[]) => {
      if (!files.length) return;
      setLoading(true);
      try {
        const result = await parseFiles(files, (p) => useStore.getState().setProgress(p));
        if (result.eventCount === 0 && result.files.every((f) => f.warnings.length)) {
          setError('No Tetragon events found in the uploaded file(s). Check the format and try again.');
          return;
        }
        setData(result.files, result.eventCount, result.dimensions);
      } catch (e) {
        setError((e as Error).message ?? String(e));
      }
    },
    [setData, setError, setLoading]
  );

  const loadSamples = useCallback(async () => {
    setLoading(true);
    try {
      const names = ['tetra_sample_1.jsonl', 'tetra_sample_2.json', 'tetra_sample_3.json'];
      const files = await Promise.all(
        names.map(async (n) => {
          const resp = await fetch(`${import.meta.env.BASE_URL}samples/${n}`);
          const blob = await resp.blob();
          return new File([blob], n);
        })
      );
      const result = await parseFiles(files, (p) => useStore.getState().setProgress(p));
      setData(result.files, result.eventCount, result.dimensions);
    } catch (e) {
      setError((e as Error).message ?? String(e));
    }
  }, [setData, setError, setLoading]);

  return (
    <div className="upload-page">
      <div className="upload-hero">
        <img src={`${import.meta.env.BASE_URL}logo.png`} alt="Tetra Browser" className="hero-logo-img" width={960} height={380} />
        <p className="subtitle">
          Explore Tetragon security event logs visually: process trees, event tables,
          tracing-policy views, and dashboards. All parsing happens locally in your browser.
        </p>
      </div>

      <div
        className={`dropzone ${dragging ? 'dragging' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          handleFiles(Array.from(e.dataTransfer.files));
        }}
        onClick={() => inputRef.current?.click()}
      >
        <div className="dz-icon">📂</div>
        <div className="dz-text">Drop Tetragon log files here, or click to browse</div>
        <div className="dz-hint">
          Supports JSONL (tetragon.log / export-stdout), JSON arrays, and gzip-compressed files.
          Multiple files are merged.
        </div>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".json,.jsonl,.gz,.log,application/json,application/gzip"
          hidden
          onChange={(e) => {
            handleFiles(Array.from(e.target.files ?? []));
            e.target.value = '';
          }}
        />
      </div>

      <div className="upload-actions">
        <button className="primary" onClick={loadSamples} disabled={loading}>
          Load sample logs
        </button>
      </div>

      {loading && (
        <div className="upload-status">
          <div className="spinner" />
          Parsing {progress ? `${progress.fileName}: ${progress.processed.toLocaleString()} / ${progress.total.toLocaleString()} lines` : '…'}
        </div>
      )}
      {error && <div className="upload-error">{error}</div>}
    </div>
  );
}
