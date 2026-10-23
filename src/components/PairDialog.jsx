import { api } from '../api.js';
import { Icon } from '../icons.jsx';
import { Modal } from './Modal.jsx';

export function PairDialog({ request, onDone }) {
  const respond = async (allow) => {
    await api.respondPair(request.requestId, allow);
    onDone(request.requestId);
  };

  return (
    <Modal
      title="Connect browser"
      onClose={() => respond(false)}
      footer={
        <>
          <button type="button" className="btn" onClick={() => respond(false)}>Decline</button>
          <button type="button" className="btn btn-primary" autoFocus onClick={() => respond(true)}>Allow</button>
        </>
      }
    >
      <div className="pair">
        <Icon name="puzzle" size={32} strokeWidth={1.5} />
        <div>
          <p>
            <strong>{request.browser}</strong> asks to send downloads to Download Manager.
          </p>
          {request.origin && <p className="muted mono small">{request.origin}</p>}
          <p className="muted">
            Allow this only if you just clicked <em>Connect</em> in the Download Manager browser extension. You can
            disconnect it later in Options → Browser.
          </p>
        </div>
      </div>
    </Modal>
  );
}
