import appIcon from '../../build/icon.png';
import { Icon } from '../icons.jsx';

const THEME_NEXT = { system: 'light', light: 'dark', dark: 'system' };
const THEME_ICON = { system: 'monitor', light: 'sun', dark: 'moon' };

// Custom title bar: the native window buttons are drawn over its right end
// (Window Controls Overlay), so content stops where they begin.
export function TitleBar({ platform, query, onQuery, onPalette, onShortcuts, theme, onTheme }) {
  return (
    <header className={`titlebar platform-${platform}`}>
      <div className="titlebar-brand">
        <img src={appIcon} alt="" width="20" height="20" />
        <span>Anabranch</span>
      </div>
      <label className="titlebar-search no-drag">
        <Icon name="search" size={15} />
        <input
          id="search"
          type="search"
          placeholder="Search downloads"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && onQuery('')}
        />
        <button type="button" className="kbd-button" onClick={onPalette} title="Command palette">
          Ctrl K
        </button>
      </label>
      <div className="titlebar-tools no-drag">
        <button
          type="button"
          className="icon-btn"
          onClick={() => onTheme(THEME_NEXT[theme])}
          title={`Theme: ${theme} (click to change)`}
          aria-label={`Theme: ${theme}`}
        >
          <Icon name={THEME_ICON[theme]} size={17} />
        </button>
        <button type="button" className="icon-btn" onClick={onShortcuts} title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts">
          <Icon name="keyboard" size={17} />
        </button>
      </div>
    </header>
  );
}
