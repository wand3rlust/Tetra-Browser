import { useState } from 'react';
import { useStore } from './store/events';
import UploadZone from './components/Upload/UploadZone';
import FilterBar from './components/FilterBar/FilterBar';
import EventTable from './components/EventTable/EventTable';
import EventDetail from './components/EventDetail/EventDetail';
import ProcessTreeView from './components/ProcessTree/ProcessTreeView';
import Dashboard from './components/Dashboard/Dashboard';
import './App.css';

type Tab = 'dashboard' | 'events' | 'tree';

export default function App() {
  const { files, eventCount, matchCount, loading, progress, error } = useStore();
  const [tab, setTab] = useState<Tab>('dashboard');
  const hasData = eventCount > 0 || files.length > 0;
  const totalWarnings = files.reduce((n, f) => n + f.warnings.length, 0);

  if (!hasData) {
    return <UploadZone />;
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-title">
          <img src={`${import.meta.env.BASE_URL}logo.png`} alt="Tetra Browser" className="app-logo" width={960} height={380} />
          <span className="file-count">
            {files.length} file{files.length === 1 ? '' : 's'} · {eventCount.toLocaleString()} events
            {totalWarnings > 0 && <span className="warn-count" title={`${totalWarnings} lines skipped (see event list banner)`}> · {totalWarnings} skipped</span>}
          </span>
        </div>
        <nav className="tabs">
          <button className={tab === 'dashboard' ? 'tab active' : 'tab'} onClick={() => setTab('dashboard')}>Dashboard</button>
          <button className={tab === 'events' ? 'tab active' : 'tab'} onClick={() => setTab('events')}>
            Events{' '}
            <span
              className={`filtered-badge ${matchCount === eventCount ? 'dim' : ''}`}
              title={`${matchCount.toLocaleString()} of ${eventCount.toLocaleString()} events`}
            >
              {matchCount.toLocaleString()}
            </span>
          </button>
          <button className={tab === 'tree' ? 'tab active' : 'tab'} onClick={() => setTab('tree')}>Process Tree</button>
        </nav>
      </header>

      {loading && (
        <div className="loading-bar">
          Parsing {progress?.fileName ?? ''}… {progress ? `${progress.processed.toLocaleString()} / ${progress.total.toLocaleString()} lines` : ''}
        </div>
      )}
      {error && <div className="error-banner">Parse failed: {error}</div>}

      <FilterBar />

      <main className="app-body">
        {tab === 'dashboard' && <Dashboard />}
        {tab === 'events' && (
          <div className="events-layout">
            <EventTable />
            <EventDetail />
          </div>
        )}
        {tab === 'tree' && <ProcessTreeView />}
      </main>
    </div>
  );
}
