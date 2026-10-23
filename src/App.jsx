import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, isMock } from './api.js';
import { applyAppearance, onSystemThemeChange } from './theme.js';
import { useSpeedHistory } from './hooks/useSpeedHistory.js';
import { TitleBar } from './components/TitleBar.jsx';
import { Sidebar } from './components/Sidebar.jsx';
import { Toolbar } from './components/Toolbar.jsx';
import { DownloadList } from './components/DownloadList.jsx';
import { DetailsPane } from './components/DetailsPane.jsx';
import { StatusBar } from './components/StatusBar.jsx';
import { ContextMenu } from './components/ContextMenu.jsx';
import { CommandPalette } from './components/CommandPalette.jsx';
import { Toasts } from './components/Toasts.jsx';
import { DropOverlay } from './components/DropOverlay.jsx';
import { AddDialog } from './components/AddDialog.jsx';
import { DeleteDialog } from './components/DeleteDialog.jsx';
import { SettingsDialog } from './components/SettingsDialog.jsx';
import { LoginDialog } from './components/LoginDialog.jsx';
import { SchedulerDialog } from './components/SchedulerDialog.jsx';
import { PairDialog } from './components/PairDialog.jsx';
import { PowerDialog } from './components/PowerDialog.jsx';
import { ShortcutsDialog } from './components/ShortcutsDialog.jsx';
import { ACTIVE } from './format.js';

const VIEW_TITLES = {
  all: 'All downloads',
  active: 'In progress',
  scheduled: 'Scheduled',
  unfinished: 'Unfinished',
  finished: 'Finished',
  attention: 'Needs attention',
};

function matchesView(d, view) {
  if (view === 'all') return true;
  if (view === 'unfinished') return d.status !== 'completed';
  if (view === 'finished') return d.status === 'completed';
  if (view === 'active') return ACTIVE.has(d.status) || d.status === 'queued';
  if (view === 'scheduled') return d.status === 'scheduled';
  if (view === 'attention') return d.status === 'error' || d.status === 'auth-required';
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

const URLS_IN_TEXT = /(?:https?|ftps?):\/\/[^\s"'<>]+/gi;
const extractUrls = (text) => [...new Set(String(text || '').match(URLS_IN_TEXT) || [])];
const needsLogin = (d) => d.status === 'auth-required' && !d.hasLogin;
const isTyping = (target) => target?.closest?.('input, textarea, select, [contenteditable]');

export default function App() {
  const [downloads, setDownloads] = useState([]);
  const [settings, setSettings] = useState(null);
  const [categories, setCategories] = useState([]);
  const [platform, setPlatform] = useState('win32');
  const [view, setView] = useState('all');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(() => new Set());
  const [sort, setSort] = useState({ key: 'createdAt', dir: 'desc' });
  const [dialog, setDialog] = useState(null);
  const [menu, setMenu] = useState(null);
  const [palette, setPalette] = useState(false);
  const [pairRequests, setPairRequests] = useState([]);
  const [countdown, setCountdown] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [dragging, setDragging] = useState(false);
  const history = useSpeedHistory(downloads);

  // At most three toasts; the oldest gives way.
  const toast = useCallback((t) => setToasts((list) => [...list.slice(-2), { id: Math.random().toString(36).slice(2), ...t }]), []);
  const dismissToast = useCallback((id) => setToasts((list) => list.filter((t) => t.id !== id)), []);

  useEffect(() => {
    api.init().then((state) => {
      setDownloads(state.downloads);
      setSettings(state.settings);
      setCategories(state.categories);
      setPairRequests(state.pendingPairs || []);
    });
    api.platform?.().then(setPlatform);
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

  // Theme, accent and density follow the settings (and the OS for "system").
  useEffect(() => {
    if (!settings) return undefined;
    applyAppearance(settings);
    return onSystemThemeChange(() => applyAppearance(settings));
  }, [settings]);

  // Toasts for downloads that finish or fail while the app is open.
  const previous = useRef(null);
  useEffect(() => {
    const before = previous.current;
    previous.current = new Map(downloads.map((d) => [d.id, d.status]));
    if (!before) return;
    for (const d of downloads) {
      const was = before.get(d.id);
      if (!was || was === d.status) continue;
      if (d.status === 'completed') {
        toast({
          kind: 'success',
          title: 'Download complete',
          body: d.fileName,
          actions: [
            { label: 'Open', run: () => api.openFile(d.id) },
            { label: 'Show in folder', run: () => api.showInFolder(d.id) },
          ],
        });
      } else if (d.status === 'error') {
        toast({ kind: 'error', title: `Failed: ${d.fileName}`, body: d.error, actions: [{ label: 'Retry', run: () => api.resume([d.id]) }] });
      }
    }
  }, [downloads, toast]);

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
  const counts = {
    total: downloads.length,
    active: downloads.filter((d) => ACTIVE.has(d.status)).length,
    queued: downloads.filter((d) => d.status === 'queued').length,
    scheduled: downloads.filter((d) => d.status === 'scheduled').length,
  };

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
  const openAdd = (urls = []) => setDialog({ type: 'add', items: urls.map((url) => ({ url })) });
  const updateSettings = (patch) => api.updateSettings(patch);

  const actions = {
    add: async () => {
      const url = await api.clipboardUrl();
      openAdd(url ? [url] : []);
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
    settings: (tab) => setDialog({ type: 'settings', tab }),
    openFolder: () => (focused ? api.showInFolder(focused.id) : api.openDownloadDir()),
    login: () => focused && openLogin(focused),
  };

  const rowAction = (run, d) => {
    if (run === 'stop') api.pause([d.id]);
    else if (run === 'resume') api.resume([d.id]);
    else if (run === 'open') api.openFile(d.id);
    else if (run === 'login') openLogin(d);
    else if (run === 'folder') api.showInFolder(d.id);
  };

  const openItem = useCallback((d) => {
    if (d.status === 'completed') api.openFile(d.id);
    else if (d.status === 'auth-required') setDialog({ type: 'login', id: d.id });
    else if (['paused', 'error', 'scheduled'].includes(d.status)) api.resume([d.id]);
  }, []);

  const toggleSelection = () => {
    if (selection.some((d) => ACTIVE.has(d.status) || d.status === 'queued')) actions.stop();
    else if (can.resume) actions.resume();
  };

  // Keyboard shortcuts (see the shortcuts sheet).
  useEffect(() => {
    const onKey = (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((open) => !open);
        return;
      }
      if (dialog || palette || isTyping(e.target)) return;
      if (menu) {
        if (e.key === 'Escape') setMenu(null);
        return;
      }
      if (e.key === 'Delete') actions.remove();
      else if (e.key === 'Insert' || (mod && e.key.toLowerCase() === 'n')) {
        e.preventDefault();
        actions.add();
      } else if (mod && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        setSelected(new Set(visible.map((d) => d.id)));
      } else if (mod && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        document.getElementById('search')?.focus();
      } else if (mod && e.key === ',') {
        e.preventDefault();
        actions.settings();
      } else if (e.key === ' ' && selection.length) {
        e.preventDefault();
        toggleSelection();
      } else if (e.key === 'Enter' && focused) openItem(focused);
      else if (e.key === '?') setDialog({ type: 'shortcuts' });
      else if (e.key === 'Escape') setSelected(new Set());
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const index = visible.findIndex((d) => selected.has(d.id));
        const next = visible[Math.max(0, Math.min(visible.length - 1, index + (e.key === 'ArrowDown' ? 1 : -1)))];
        if (next) setSelected(new Set([next.id]));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Ctrl+V anywhere outside a text field adds the links on the clipboard.
  useEffect(() => {
    const onPaste = (e) => {
      if (dialog || isTyping(e.target)) return;
      const urls = extractUrls(e.clipboardData?.getData('text'));
      if (urls.length) {
        e.preventDefault();
        openAdd(urls);
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  });

  // Links or a .txt list dropped on the window open the Add dialog.
  useEffect(() => {
    let depth = 0;
    const accepts = (e) => [...(e.dataTransfer?.types || [])].some((t) => ['text/uri-list', 'text/plain', 'Files'].includes(t));
    const enter = (e) => {
      if (!accepts(e)) return;
      e.preventDefault();
      depth++;
      setDragging(true);
    };
    const over = (e) => accepts(e) && e.preventDefault();
    const leave = () => {
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    };
    const drop = async (e) => {
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const texts = [e.dataTransfer.getData('text/uri-list'), e.dataTransfer.getData('text/plain')];
      for (const file of e.dataTransfer.files || []) {
        if (/\.(txt|csv|list|urls?)$/i.test(file.name) || file.type.startsWith('text/')) texts.push(await file.text());
      }
      const urls = extractUrls(texts.join('\n'));
      if (urls.length) openAdd(urls);
      else toast({ kind: 'info', title: 'No links found', body: 'Drop links, or a text file with one link per line.' });
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, [toast]);

  const commands = [
    { label: 'New download', icon: 'plus', keywords: 'add url link', run: actions.add },
    { label: 'Resume selected', icon: 'play', run: actions.resume, disabled: !can.resume },
    { label: 'Pause selected', icon: 'pause', run: actions.stop, disabled: !can.stop },
    { label: 'Schedule selected', icon: 'calendar', run: actions.schedule, disabled: !can.schedule },
    { label: 'Delete selected', icon: 'trash', run: actions.remove, disabled: !can.remove },
    { label: 'Resume all', icon: 'playAll', run: actions.resumeAll, disabled: !can.resumeAll },
    { label: 'Pause all', icon: 'stopAll', keywords: 'stop', run: actions.stopAll, disabled: !can.stopAll },
    { label: 'Clear finished downloads', icon: 'sweep', keywords: 'remove completed', run: actions.removeCompleted, disabled: !can.removeCompleted },
    { label: 'Open download folder', icon: 'folder', run: () => api.openDownloadDir() },
    { label: 'Scheduler…', icon: 'calendar', keywords: 'time night', run: actions.scheduler },
    { label: 'Options…', icon: 'gear', keywords: 'settings preferences', run: () => actions.settings() },
    { label: 'Theme: light', icon: 'sun', keywords: 'appearance', run: () => updateSettings({ theme: 'light' }) },
    { label: 'Theme: dark', icon: 'moon', keywords: 'appearance', run: () => updateSettings({ theme: 'dark' }) },
    { label: 'Theme: follow Windows', icon: 'monitor', keywords: 'appearance system', run: () => updateSettings({ theme: 'system' }) },
    {
      label: settings?.density === 'compact' ? 'Comfortable rows' : 'Compact table',
      icon: settings?.density === 'compact' ? 'rows' : 'list',
      keywords: 'density view',
      run: () => updateSettings({ density: settings?.density === 'compact' ? 'comfortable' : 'compact' }),
    },
    { label: 'Speed limit: off', icon: 'gauge', run: () => updateSettings({ speedLimitKBps: 0 }) },
    { label: 'Speed limit: 1 MB/s', icon: 'gauge', run: () => updateSettings({ speedLimitKBps: 1024 }) },
    { label: 'Connect browser extension…', icon: 'puzzle', run: () => actions.settings('browser') },
    { label: 'Connect Claude (MCP)…', icon: 'sparkle', run: () => actions.settings('mcp') },
    { label: 'Keyboard shortcuts', icon: 'keyboard', run: () => setDialog({ type: 'shortcuts' }) },
    ...Object.entries(VIEW_TITLES).map(([key, title]) => ({ label: `Show: ${title}`, icon: 'all', run: () => setView(key) })),
  ];

  const loginDownload = dialog?.type === 'login' ? downloads.find((d) => d.id === dialog.id) : null;
  const viewTitle = VIEW_TITLES[view] || view.replace('cat:', '');
  const density = settings?.density || 'comfortable';
  // Live readouts use the current list; the history only feeds the graphs.
  const totalSpeed = downloads.reduce((s, d) => s + (d.speed || 0), 0);

  return (
    <div className="app" onClick={() => menu && setMenu(null)}>
      <TitleBar
        platform={platform}
        query={query}
        onQuery={setQuery}
        onPalette={() => setPalette(true)}
        onShortcuts={() => setDialog({ type: 'shortcuts' })}
        theme={settings?.theme || 'system'}
        onTheme={(theme) => updateSettings({ theme })}
      />
      <div className="workspace">
        <Sidebar
          downloads={downloads}
          categories={categories}
          view={view}
          onView={setView}
          onAdd={actions.add}
          speedSamples={history.total}
          speed={totalSpeed}
        />
        <main className="content">
          {downloads.length > 0 && (
            <Toolbar
              title={viewTitle}
              count={visible.length}
              can={can}
              actions={actions}
              sort={sort}
              onSort={setSort}
              density={density}
              onDensity={(value) => updateSettings({ density: value })}
              selectionSize={selection.length}
            />
          )}
          <DownloadList
            items={visible}
            total={downloads.length}
            density={density}
            selected={selected}
            onSelect={setSelected}
            sort={sort}
            onSort={setSort}
            onOpen={openItem}
            onRowAction={rowAction}
            schedule={settings?.schedule}
            onContextMenu={(e, d, rect) => {
              e.preventDefault();
              e.stopPropagation();
              if (!selected.has(d.id)) setSelected(new Set([d.id]));
              setMenu(rect ? { x: rect.right - 200, y: rect.bottom + 4, id: d.id } : { x: e.clientX, y: e.clientY, id: d.id });
            }}
            welcomeActions={{ add: actions.add, browser: () => actions.settings('browser'), mcp: () => actions.settings('mcp') }}
          />
          {focused && (
            <DetailsPane
              key={focused.id}
              download={focused}
              samples={history.byId.get(focused.id)}
              onLogin={() => openLogin(focused)}
              onClose={() => setSelected(new Set())}
            />
          )}
        </main>
      </div>
      <StatusBar counts={counts} settings={settings} totalSpeed={totalSpeed} isMock={isMock} onScheduler={actions.scheduler} />

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
      {palette && (
        <CommandPalette
          commands={commands}
          downloads={downloads}
          onPickDownload={(d) => {
            setView('all');
            setQuery('');
            setSelected(new Set([d.id]));
          }}
          onClose={() => setPalette(false)}
        />
      )}
      {dialog?.type === 'add' && settings && (
        <AddDialog
          items={dialog.items}
          settings={settings}
          onClose={(result) => {
            setDialog(null);
            if (result?.added) {
              const what = result.added === 1 ? 'Download' : `${result.added} downloads`;
              const verb = result.mode === 'schedule' ? 'scheduled' : result.mode === 'later' ? 'added paused' : 'started';
              toast({ kind: 'info', title: `${what} ${verb}` });
            }
          }}
        />
      )}
      {dialog?.type === 'delete' && (
        <DeleteDialog items={downloads.filter((d) => dialog.ids.includes(d.id))} onClose={() => setDialog(null)} />
      )}
      {dialog?.type === 'settings' && settings && (
        <SettingsDialog settings={settings} initialTab={dialog.tab} onClose={() => setDialog(null)} />
      )}
      {dialog?.type === 'scheduler' && settings && (
        <SchedulerDialog settings={settings} scheduledCount={counts.scheduled} onClose={() => setDialog(null)} />
      )}
      {dialog?.type === 'shortcuts' && <ShortcutsDialog onClose={() => setDialog(null)} />}
      {loginDownload && <LoginDialog download={loginDownload} onClose={() => setDialog(null)} />}
      {pairRequests[0] && (
        <PairDialog request={pairRequests[0]} onDone={(id) => setPairRequests((list) => list.filter((r) => r.requestId !== id))} />
      )}
      {countdown && <PowerDialog countdown={countdown} />}
      {dragging && <DropOverlay />}
      <Toasts toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
