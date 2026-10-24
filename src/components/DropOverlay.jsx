import { Icon } from '../icons.jsx';

export function DropOverlay() {
  return (
    <div className="drop-overlay" aria-hidden="true">
      <div className="drop-target">
        <Icon name="drop" size={40} strokeWidth={1.6} />
        <strong>Drop to download</strong>
        <span>Links, or a .txt file with one link per line</span>
      </div>
    </div>
  );
}
