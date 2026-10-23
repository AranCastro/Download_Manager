import { Modal } from './Modal.jsx';

const SHORTCUTS = [
  ['Ctrl K', 'Command palette'],
  ['Ctrl N  or  Insert', 'New download'],
  ['Ctrl V', 'Add the link(s) on the clipboard'],
  ['Ctrl F', 'Search downloads'],
  ['Space', 'Pause or resume the selection'],
  ['Enter', 'Open, retry or sign in'],
  ['Delete', 'Delete the selection'],
  ['Ctrl A', 'Select all'],
  ['Ctrl ,', 'Options'],
  ['Esc', 'Close the details or clear the selection'],
  ['?', 'This list'],
];

export function ShortcutsDialog({ onClose }) {
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose}>
      <dl className="shortcuts">
        {SHORTCUTS.map(([keys, what]) => (
          <div key={keys}>
            <dt>
              {keys.split('  or  ').map((k, i) => (
                <span key={k}>
                  {i > 0 && <span className="muted"> or </span>}
                  {k.split(' ').map((part) => <kbd key={part}>{part}</kbd>)}
                </span>
              ))}
            </dt>
            <dd>{what}</dd>
          </div>
        ))}
      </dl>
    </Modal>
  );
}
