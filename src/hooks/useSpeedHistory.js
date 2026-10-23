import { useEffect, useRef, useState } from 'react';

const SAMPLES = 90;

// Samples total and per-download speed once a second, keeping the last 90
// seconds for the sidebar sparkline and the details chart.
export function useSpeedHistory(downloads) {
  const latest = useRef(downloads);
  latest.current = downloads;
  const history = useRef({ total: [], byId: new Map() });
  const [, setTick] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      const { total, byId } = history.current;
      let sum = 0;
      const seen = new Set();
      for (const d of latest.current) {
        const speed = d.speed || 0;
        sum += speed;
        seen.add(d.id);
        const list = byId.get(d.id) || [];
        if (speed || list.length) {
          list.push({ t: now, v: speed });
          if (list.length > SAMPLES) list.shift();
          byId.set(d.id, list);
        }
      }
      for (const id of byId.keys()) if (!seen.has(id)) byId.delete(id);
      total.push({ t: now, v: sum });
      if (total.length > SAMPLES) total.shift();
      setTick((n) => n + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  return history.current;
}
