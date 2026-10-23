import { Icon } from '../icons.jsx';

// First-run screen: what the app can do and the fastest way to start.
export function Welcome({ actions }) {
  const cards = [
    {
      icon: 'link',
      title: 'Paste or drop a link',
      body: 'Press Ctrl+V anywhere, drag links or a .txt list onto this window, or copy a file link: the app notices.',
      cta: 'Add a download',
      run: actions.add,
    },
    {
      icon: 'puzzle',
      title: 'Connect your browser',
      body: 'Send browser downloads, links and video streams here, with your sign-in cookies.',
      cta: 'Set up the extension',
      run: actions.browser,
    },
    {
      icon: 'sparkle',
      title: 'Let Claude download for you',
      body: 'The MCP server lets Claude queue files, check links and schedule downloads.',
      cta: 'Connect Claude',
      run: actions.mcp,
    },
  ];
  return (
    <div className="welcome">
      <div className="welcome-art" aria-hidden="true">
        <svg viewBox="0 0 120 120" width="96" height="96">
          <rect x="10" y="10" width="100" height="100" rx="26" className="art-tile" />
          <path d="M60 30v40M45 56l15 15 15-15" className="art-arrow" />
          {[0, 1, 2, 3].map((i) => (
            <rect key={i} x={30 + i * 16} y="84" width="12" height="7" rx="3.5" className="art-seg" style={{ opacity: 1 - i * 0.22 }} />
          ))}
        </svg>
      </div>
      <h2>Ready when you are</h2>
      <p className="muted">Files, FTP links and HLS/DASH video streams, over up to 32 connections each.</p>
      <div className="welcome-cards">
        {cards.map((c) => (
          <button key={c.title} type="button" className="welcome-card" onClick={c.run}>
            <span className="welcome-icon"><Icon name={c.icon} size={20} /></span>
            <strong>{c.title}</strong>
            <span className="muted">{c.body}</span>
            <span className="welcome-cta">
              {c.cta} <Icon name="chevronDown" size={14} className="rotate-270" />
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
