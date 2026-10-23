import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, isMock } from './api.js';
import { Toolbar } from './components/Toolbar.jsx';
import { Sidebar } from './components/Sidebar.jsx';
import { DownloadTable } from './components/DownloadTable.jsx';
import { DetailsPane } from './components/DetailsPane.jsx';
import { ContextMenu } from './components/ContextMenu.jsx';
import { AddDialog } from './components/AddDialog.jsx';
import { DeleteDialog } from './components/DeleteDialog.jsx';
import { SettingsDialog } from './components/SettingsDialog.jsx';
import { formatSpeed } from './format.js';

const ACTIVE = new Set(['connecting', 'downloading']);

function matchesView(d, view) {
  if (view === 'all') return true;
  if (view === 'unfinished') return d.status !== 'completed';
  if (view === 'finished') return d.status === 'completed';
  if (view === 'active') return ACTIVE.has(d.status) || d.status === 'queued';
  return view === `cat:${d.category}`;
}

const SORTERS = {
  fileName: (d) => (d.fileName || d.url).toLowerCase(),
  totalBytes: (d) => d.totalBytes ?? -1,
  status: (d) => d.status,
  progress: (d) => (d.totalBytes ? d.downloadedBytes / d.totalBytes : 0),
  eta: (d) => d.eta ?? Infinity,
  speed: (d) => d.speed || 0,
  createdAt: (d) => d.createdAt,
};

export default function App() {
  const [downloads, setDownloads] = useState([]);
  const [settings, setSettings] = useState(null);
  const [categories, setCategories] = useState([]);
  const [view, setView] = useState('all');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(() => new Set());
  const [sort, setSort] = useState({ key: 'createdAt', dir: 'desc' });
  const [dialog, setDialog] = useState(null);
  const [menu, setMenu] = useState(null);

  useEffect(() => {
    api.init().then((state) => {
      setDownloads(state.downloads);
      setSettings(state.settings);
      setCategories(state.categories);
    });
    const offs = [
      api.onUpdate(setDownloads),
      api.onSettings(setSettings),
      api.onPromptAdd((url) => setDialog({ type: 'add', url })),
    ];
    return () => offs.forEach((off) => off());
  }, []);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const key = SORTERS[sort.key];
    const factor = sort.dir === 'asc' ? 1 : -1;
    return downloads
      .filter((d) => matchesView(d, view))
      .filter((d) => !q || `${d.fileName} ${d.url}`.toLowerCase().includes(q))
      .sort((a, b) => (key(a) > key(b) ? factor : key(a) < key(b) ? -factor : 0));
  }, [downloads, view, query, sort]);

  // Drop selections that no longer exist.
  useEffect(() => {
    const ids = new Set(downloads.map((d) => d.id));
    setSelected((prev) => {
      const next = new Set([...prev].filter((id) => ids.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [downloads]);

  const selection = downloads.filter((d) => selected.has(d.id));
  const ids = selection.map((d) => d.id);
  const focused = selection.length === 1 ? selection[0] : null;

  const can = {
    resume: selection.some((d) => d.status === 'paused' || d.status === 'error'),
    stop: selection.some((d) => ACTIVE.has(d.status) || d.status === 'queued'),
    remove: selection.length > 0,
    removeCompleted: downloads.some((d) => d.status === 'completed'),
    resumeAll: downloads.some((d) => d.status === 'paused' || d.status === 'error'),
    stopAll: downloads.some((d) => ACTIVE.has(d.status) || d.status === 'queued'),
  };

  const actions = {
    add: async () => setDialog({ type: 'add', url: await api.clipboardUrl() }),
    resume: () => api.resume(ids),
    stop: () => api.pause(ids),
    resumeAll: () => api.resumeAll(),
    stopAll: () => api.pauseAll(),
    remove: () => ids.length && setDialog({ type: 'delete', ids }),
    removeCompleted: () => api.removeCompleted(),
    settings: () => setDialog({ type: 'settings' }),
    openFolder: () => (focused ? api.showInFolder(focused.id) : api.openDownloadDir()),
  };

  const openItem = useCallback((d) => {
    if (d.status === 'completed') api.openFile(d.id);
    else if (d.status === 'paused' || d.status === 'error') api.resume([d.id]);
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (dialog || e.target.closest('input, textarea, select')) return;
      if (menu) {
        if (e.key === 'Escape') setMenu(null);
        return;
      }
      if (e.key === 'Delete') actions.remove();
      else if (e.key === 'Insert' || ((e.ctrlKey || e.metaKey) && e.key === 'n')) {
        e.preventDefault();
        actions.add();
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
        e.preventDefault();
        setSelected(new Set(visible.map((d) => d.id)));
      } else if (e.key === 'Enter' && focused) openItem(focused);
      else if (e.key === 'Escape') setSelected(new Set());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const totalSpeed = downloads.reduce((sum, d) => sum + (d.speed || 0), 0);
  const activeCount = downloads.filter((d) => ACTIVE.has(d.status)).length;
  const queuedCount = downloads.filter((d) => d.status === 'queued').length;

  return (
    <div className="app" onClick={() => menu && setMenu(null)}>
      <Toolbar can={can} actions={actions} query={query} onQuery={setQuery} />
      <div className="workspace">
        <Sidebar downloads={downloads} categories={categories} view={view} onView={setView} />
        <main className="content">
          <DownloadTable
            items={visible}
            selected={selected}
            onSelect={setSelected}
            sort={sort}
            onSort={setSort}
            onOpen={openItem}
            onContextMenu={(e, d) => {
              e.preventDefault();
              if (!selected.has(d.id)) setSelected(new Set([d.id]));
              setMenu({ x: e.clientX, y: e.clientY, id: d.id });
            }}
            emptyHint={downloads.length === 0}
            onAdd={actions.add}
          />
          {focused && <DetailsPane download={focused} />}
        </main>
      </div>
      <footer className="statusbar">
        <span>
          {downloads.length} downloads · {activeCount} active{queuedCount ? ` · ${queuedCount} queued` : ''}
        </span>
        <span className="statusbar-right">
          {settings?.speedLimitKBps ? (
            <span className="pill pill-warn">Limit {settings.speedLimitKBps} KB/s</span>
          ) : null}
          {isMock && <span className="pill">Browser preview</span>}
          <span className="total-speed">{formatSpeed(totalSpeed) || 'Idle'}</span>
        </span>
      </footer>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          download={downloads.find((d) => d.id === menu.id)}
          selectionSize={ids.length}
          actions={actions}
          onClose={() => setMenu(null)}
        />
      )}
      {dialog?.type === 'add' && settings && (
        <AddDialog initialUrl={dialog.url} settings={settings} onClose={() => setDialog(null)} />
      )}
      {dialog?.type === 'delete' && (
        <DeleteDialog
          items={downloads.filter((d) => dialog.ids.includes(d.id))}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.type === 'settings' && settings && (
        <SettingsDialog settings={settings} onClose={() => setDialog(null)} />
      )}
    </div>
  );
}
