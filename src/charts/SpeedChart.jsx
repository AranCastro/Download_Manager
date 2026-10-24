import { useLayoutEffect, useRef, useState } from 'react';
import { formatSpeed } from '../format.js';

// A "nice" upper bound (1, 2 or 5 × 10^n) so gridlines land on round values.
function niceMax(value) {
  if (value <= 0) return 1024 * 1024;
  const exp = 10 ** Math.floor(Math.log10(value));
  const f = value / exp;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * exp;
}

function useWidth() {
  const ref = useRef(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

function secondsAgo(t) {
  const s = Math.round((Date.now() - t) / 1000);
  return s <= 1 ? 'now' : `${s} s ago`;
}

// Throughput over the last 90 seconds: one series, so no legend; the title
// names it. 2px line, 10% area wash, ringed end dot, hairline grid, and a
// crosshair that snaps to the nearest sample.
export function SpeedChart({ samples, height = 140, title = 'Transfer rate', compact = false }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState(null);
  const pad = compact ? { l: 0, r: 6, t: 6, b: 4 } : { l: 64, r: 12, t: 10, b: 22 };
  const w = Math.max(0, width - pad.l - pad.r);
  const h = height - pad.t - pad.b;
  const n = samples.length;
  const max = niceMax(Math.max(0, ...samples.map((s) => s.v)));
  const x = (i) => pad.l + (n <= 1 ? w : (i / (n - 1)) * w);
  const y = (v) => pad.t + h - (v / max) * h;

  const line = samples.map((s, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(s.v).toFixed(1)}`).join('');
  const area = n ? `${line}L${x(n - 1).toFixed(1)},${pad.t + h}L${x(0).toFixed(1)},${pad.t + h}Z` : '';
  const last = samples[n - 1];
  const point = hover != null ? samples[hover] : null;
  const values = samples.map((s) => s.v);
  const peak = Math.max(0, ...values);
  const avg = n ? values.reduce((a, b) => a + b, 0) / n : 0;

  const onMove = (e) => {
    if (!n) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left - pad.l;
    setHover(Math.max(0, Math.min(n - 1, Math.round((px / Math.max(1, w)) * (n - 1)))));
  };

  const summary = `${title}: now ${formatSpeed(last?.v) || '0 B/s'}, average ${formatSpeed(avg) || '0 B/s'}, peak ${formatSpeed(peak) || '0 B/s'}`;

  return (
    <figure className={`speed-chart ${compact ? 'is-compact' : ''}`} aria-label={summary}>
      {!compact && (
        <figcaption className="chart-head">
          <span className="chart-title">{title}</span>
          <span className="chart-stats">
            <span>Now <strong>{formatSpeed(last?.v) || '0 B/s'}</strong></span>
            <span>Average <strong>{formatSpeed(avg) || '0 B/s'}</strong></span>
            <span>Peak <strong>{formatSpeed(peak) || '0 B/s'}</strong></span>
          </span>
        </figcaption>
      )}
      <div className="chart-box" ref={ref} style={{ height }}>
        {width > 0 && (
          <svg width={width} height={height} onPointerMove={onMove} onPointerLeave={() => setHover(null)} role="img" aria-label={summary}>
            {!compact &&
              [0, 0.5, 1].map((f) => (
                <g key={f}>
                  <line className="chart-grid" x1={pad.l} x2={pad.l + w} y1={y(max * f)} y2={y(max * f)} />
                  <text className="chart-axis" x={pad.l - 8} y={y(max * f) + 4} textAnchor="end">
                    {f === 0 ? '0' : formatSpeed(max * f)}
                  </text>
                </g>
              ))}
            {!compact && (
              <>
                <text className="chart-axis" x={pad.l} y={height - 4}>90 s ago</text>
                <text className="chart-axis" x={pad.l + w} y={height - 4} textAnchor="end">now</text>
              </>
            )}
            {compact && <line className="chart-grid" x1={pad.l} x2={pad.l + w} y1={pad.t + h} y2={pad.t + h} />}
            <path className="chart-area" d={area} />
            <path className="chart-line" d={line} />
            {last && hover == null && <circle className="chart-dot" cx={x(n - 1)} cy={y(last.v)} r="4" />}
            {point && (
              <>
                <line className="chart-crosshair" x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + h} />
                <circle className="chart-dot" cx={x(hover)} cy={y(point.v)} r="4" />
              </>
            )}
          </svg>
        )}
        {point && (
          // Beside the crosshair, on whichever side has room, inside the plot.
          <div
            className="chart-tooltip"
            style={{
              left: x(hover),
              top: compact ? -40 : pad.t + 4,
              transform: x(hover) > width / 2 ? 'translateX(calc(-100% - 10px))' : 'translateX(10px)',
            }}
          >
            <strong>{formatSpeed(point.v) || '0 B/s'}</strong>
            <span>{secondsAgo(point.t)}</span>
          </div>
        )}
      </div>
    </figure>
  );
}
