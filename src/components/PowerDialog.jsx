import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Icon } from '../icons.jsx';
import { Modal } from './Modal.jsx';

const VERB = {
  quit: 'Anabranch will close',
  sleep: 'The computer will go to sleep',
  shutdown: 'The computer will shut down',
};

export function PowerDialog({ countdown }) {
  const [left, setLeft] = useState(countdown.seconds);

  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(() => {
      setLeft(Math.max(0, countdown.seconds - Math.floor((Date.now() - started) / 1000)));
    }, 250);
    return () => clearInterval(timer);
  }, [countdown]);

  const cancel = () => api.cancelPowerAction();

  return (
    <Modal
      title="Scheduled downloads finished"
      onClose={cancel}
      footer={
        <button type="button" className="btn btn-primary" autoFocus onClick={cancel}>
          Cancel
        </button>
      }
    >
      <div className="power">
        <Icon name="power" size={32} />
        <p>
          {VERB[countdown.action]} in <strong className="countdown">{left}</strong> seconds.
        </p>
      </div>
    </Modal>
  );
}
