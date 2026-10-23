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
import { LoginDialog } from './components/LoginDialog.jsx';
import { SchedulerDialog } from './components/SchedulerDialog.jsx';
import { PairDialog } from './components/PairDialog.jsx';
import { PowerDialog } from './components/PowerDialog.jsx';
import { ACTIVE, formatSpeed } from './format.js';

function matchesView(d, view) {
  if (view === 'all') return true;
  if (view === 'unfinished') return d.status !== 'completed';
  if (view === 'finished') return d.status === 'completed';
  if (view === 'active') return ACTIVE.has(d.status) || d.status === 'queued';
  if (view === 'scheduled') return d.status === 'scheduled';
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

const needsLogin = (d) => d.status === 'auth-required' && !d.hasLogin;

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
  const [pairRequests, setPairRequests] = useState([]);
  const [countdown, setCountdown] = useState(null);

  useEffect(() => {
    api.init().then((state) => {
      setDownloads(state.downloads);
      setSettings(state.settings);
      setCategories(state.categories);
      setPairRequests(state.pendingPairs || []);
    });
    const offs = [
      api.onUpdate(setDownloads),
      api.onSettings(setSettings),
      api.onPromptAdd(({ items }) => setDialog({ type: 'add', items })),
      // A login prompt never replaces a dialog the user is working in.
      api.onAuthRequired((d) => setDialog((current) => current ?? { type: 'login', id: d.id })),
      api.onPairRequest((request) => setPairRequests((list) => [...list, request])),
      api.onPairClosed((requestId) => setPairRequests((list) => list.filter((r) => r.requestId !== requestId))),
      api.onPowerCountdown(setCountdown),
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
  const scheduledCount = downloads.filter((d) => d.status === 'scheduled').length;

  const can = {
    resume: selection.some((d) => ['paused', 'error', 'scheduled', 'auth-required'].includes(d.status)),
    stop: selection.some((d) => ACTIVE.has(d.status) || d.status === 'queued'),
    remove: selection.length > 0,
    removeCompleted: downloads.some((d) => d.status === 'completed'),
    resumeAll: downloads.some((d) => d.status === 'paused' || d.status === 'error'),
    stopAll: downloads.some((d) => ACTIVE.has(d.status) || d.status === 'queued'),
    schedule: selection.some((d) => d.status !== 'completed' && d.status !== 'scheduled'),
  };

  const openLogin = (d) => setDialog({ type: 'login', id: d.id });

  const actions = {
    add: async () => {
      const url = await api.clipboardUrl();
      setDialog({ type: 'add', items: url ? [{ url }] : [] });
    },
    resume: () => {
      const login = selection.find(needsLogin);
      if (login) openLogin(login);
      api.resume(selection.filter((d) => !needsLogin(d)).map((d) => d.id));
    },
    stop: () => api.pause(ids),
    resumeAll: () => api.resumeAll(),
    stopAll: () => api.pauseAll(),
    remove: () => ids.length && setDialog({ type: 'delete', ids }),
    removeCompleted: () => api.removeCompleted(),
    schedule: () => api.schedule(selection.filter((d) => d.status !== 'completed').map((d) => d.id)),
    scheduler: () => setDialog({ type: 'scheduler' }),
    settings: () => setDialog({ type: 'settings' }),
    openFolder: () => (focused ? api.showInFolder(focused.id) : api.openDownloadDir()),
    login: () => focused && openLogin(focused),
  };

  const openItem = useCallback((d) => {
    if (d.status === 'completed') api.openFile(d.id);
    else if (d.status === 'auth-required') setDialog({ type: 'login', id: d.id });
    else if (['paused', 'error', 'scheduled'].includes(d.status)) api.resume([d.id]);
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
  const loginDownload = dialog?.type === 'login' ? downloads.find((d) => d.id === dialog.id) : null;
  const schedule = settings?.schedule;

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
          {focused && <DetailsPane download={focused} onLogin={() => openLogin(focused)} />}
        </main>
      </div>
      <footer className="statusbar">
        <span>
          {downloads.length} downloads · {activeCount} active{queuedCount ? ` · ${queuedCount} queued` : ''}
          {scheduledCount ? ` · ${scheduledCount} scheduled` : ''}
        </span>
        <span className="statusbar-right">
          {schedule?.enabled && (
            <button type="button" className="pill pill-link" onClick={actions.scheduler}>
              Scheduler {schedule.startTime}
              {schedule.stopTime ? `–${schedule.stopTime}` : ''}
            </button>
          )}
          {settings?.speedLimitKBps ? <span className="pill pill-warn">Limit {settings.speedLimitKBps} KB/s</span> : null}
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
        <AddDialog items={dialog.items} settings={settings} onClose={() => setDialog(null)} />
      )}
      {dialog?.type === 'delete' && (
        <DeleteDialog items={downloads.filter((d) => dialog.ids.includes(d.id))} onClose={() => setDialog(null)} />
      )}
      {dialog?.type === 'settings' && settings && <SettingsDialog settings={settings} onClose={() => setDialog(null)} />}
      {dialog?.type === 'scheduler' && settings && (
        <SchedulerDialog settings={settings} scheduledCount={scheduledCount} onClose={() => setDialog(null)} />
      )}
      {loginDownload && <LoginDialog download={loginDownload} onClose={() => setDialog(null)} />}
      {pairRequests[0] && (
        <PairDialog
          request={pairRequests[0]}
          onDone={(id) => setPairRequests((list) => list.filter((r) => r.requestId !== id))}
        />
      )}
      {countdown && <PowerDialog countdown={countdown} />}
    </div>
  );
}
