'use strict';

const { XMLParser } = require('fast-xml-parser');

// MPEG-DASH manifest (ISO/IEC 23009-1) resolution for on-demand streams:
// SegmentTemplate (with or without SegmentTimeline), SegmentList and
// single-file representations (BaseURL / SegmentBase).

const ARRAYS = new Set(['Period', 'AdaptationSet', 'Representation', 'S', 'SegmentURL', 'BaseURL', 'ContentProtection']);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  removeNSPrefix: true,
  isArray: (name) => ARRAYS.has(name),
});

// ISO 8601 durations as used in MPDs, e.g. PT1H2M3.5S → 3723.5 seconds.
function parseDuration(value) {
  if (!value) return null;
  const m = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(
    String(value).trim(),
  );
  if (!m) return null;
  const [, d = 0, h = 0, min = 0, s = 0] = m.map((x) => Number(x) || 0);
  return d * 86400 + h * 3600 + min * 60 + s;
}

function text(node) {
  if (node == null) return null;
  return typeof node === 'object' ? node['#text'] ?? null : String(node);
}

function baseOf(node, parentBase) {
  const value = text(node?.BaseURL?.[0]);
  return value ? new URL(value.trim(), parentBase).href : parentBase;
}

// Expands $RepresentationID$, $Number$, $Number%05d$, $Bandwidth$, $Time$, $$.
function fillTemplate(template, values) {
  return template.replace(/\$(RepresentationID|Number|Bandwidth|Time|)(?:%0(\d+)d)?\$/g, (_, name, width) => {
    if (!name) return '$';
    const value = String(values[name]);
    return width ? value.padStart(Number(width), '0') : value;
  });
}

function parseRange(range) {
  if (!range) return null;
  const [from, to] = String(range).split('-').map(Number);
  return { offset: from, length: to - from + 1 };
}

function isProtected(node) {
  return Array.isArray(node?.ContentProtection) && node.ContentProtection.length > 0;
}

function contentTypeOf(set) {
  const rep = set.Representation?.[0] || {};
  const type = set.contentType || set.mimeType || rep.mimeType || '';
  if (type.includes('video')) return 'video';
  if (type.includes('audio')) return 'audio';
  return 'other';
}

function segmentsFor(set, rep, base, periodDuration) {
  const repBase = baseOf(rep, base);
  const template = { ...(set.SegmentTemplate || {}), ...(rep.SegmentTemplate || {}) };
  const values = { RepresentationID: rep.id, Bandwidth: rep.bandwidth };
  const resolve = (uri) => new URL(uri, repBase).href;

  if (template.media) {
    const timescale = Number(template.timescale) || 1;
    const startNumber = Number(template.startNumber ?? 1);
    const init = template.initialization ? { uri: resolve(fillTemplate(template.initialization, values)) } : null;
    const segments = [];
    const timeline = template.SegmentTimeline?.S;
    if (timeline) {
      let time = 0;
      let number = startNumber;
      const periodEnd = periodDuration != null ? periodDuration * timescale : null;
      for (const s of timeline) {
        if (s.t != null) time = Number(s.t);
        const d = Number(s.d);
        let repeat = Number(s.r ?? 0);
        if (repeat < 0) repeat = periodEnd != null ? Math.ceil((periodEnd - time) / d) - 1 : 0;
        for (let i = 0; i <= repeat; i++) {
          segments.push({ uri: resolve(fillTemplate(template.media, { ...values, Number: number, Time: time })) });
          time += d;
          number++;
        }
      }
    } else {
      const duration = Number(template.duration);
      if (!duration || periodDuration == null) throw new Error('DASH manifest lacks segment durations');
      const count = Math.ceil((periodDuration * timescale) / duration);
      for (let i = 0; i < count; i++) {
        const number = startNumber + i;
        segments.push({ uri: resolve(fillTemplate(template.media, { ...values, Number: number, Time: i * duration })) });
      }
    }
    return { init, segments };
  }

  const list = rep.SegmentList || set.SegmentList;
  if (list?.SegmentURL) {
    const initNode = list.Initialization;
    const init = initNode
      ? { uri: resolve(initNode.sourceURL || repBase), byteRange: parseRange(initNode.range) }
      : null;
    const segments = list.SegmentURL.map((s) => ({
      uri: resolve(s.media || repBase),
      byteRange: parseRange(s.mediaRange),
    }));
    return { init, segments };
  }

  // A single self-contained file (SegmentBase or bare BaseURL).
  return { init: null, segments: [{ uri: repBase }] };
}

function pick(reps, quality) {
  const sorted = [...reps].sort((a, b) => (Number(a.bandwidth) || 0) - (Number(b.bandwidth) || 0));
  if (quality === 'worst') return sorted[0];
  const height = Number(quality);
  if (Number.isFinite(height) && height > 0) {
    const fitting = sorted.filter((r) => Number(r.height) && Number(r.height) <= height);
    return fitting.length ? fitting[fitting.length - 1] : sorted[0];
  }
  return sorted[sorted.length - 1];
}

function extensionFor(set, rep, type) {
  const mime = rep.mimeType || set.mimeType || '';
  if (mime.includes('webm')) return '.webm';
  return type === 'audio' ? '.m4a' : '.mp4';
}

function resolveDashManifest(xml, manifestUrl, quality = 'best') {
  const doc = parser.parse(xml);
  const mpd = doc.MPD;
  if (!mpd) throw new Error('Not a DASH manifest (missing <MPD>)');
  if (mpd.type === 'dynamic') {
    throw Object.assign(new Error('Live DASH streams cannot be downloaded yet'), { fatal: true });
  }
  const period = mpd.Period?.[0];
  if (!period) throw new Error('The DASH manifest has no periods');
  const periodDuration = parseDuration(period.duration) ?? parseDuration(mpd.mediaPresentationDuration);
  const base = baseOf(period, baseOf(mpd, manifestUrl));

  const tracks = [];
  let info = {};
  for (const type of ['video', 'audio']) {
    const sets = (period.AdaptationSet || []).filter((s) => contentTypeOf(s) === type);
    const candidates = sets.flatMap((set) => (set.Representation || []).map((rep) => ({ set, rep })));
    if (!candidates.length) continue;
    const rep = pick(candidates.map((c) => c.rep), type === 'video' ? quality : 'best');
    const { set } = candidates.find((c) => c.rep === rep);
    if (isProtected(set) || isProtected(rep)) {
      throw Object.assign(new Error('This stream is DRM-protected and cannot be downloaded'), { fatal: true });
    }
    const { init, segments } = segmentsFor(set, rep, baseOf(set, base), periodDuration);
    tracks.push({ type, init, segments, ext: extensionFor(set, rep, type) });
    if (type === 'video') {
      info = { width: Number(rep.width) || null, height: Number(rep.height) || null, bandwidth: Number(rep.bandwidth) || null };
    }
  }
  if (!tracks.length) throw new Error('The DASH manifest has no audio or video');
  if (tracks.length === 1) tracks[0].type = 'main';
  return { info, tracks };
}

async function resolveDash(url, fetchText, quality) {
  return resolveDashManifest(await fetchText(url), url, quality);
}

module.exports = { resolveDash, resolveDashManifest, parseDuration, fillTemplate };
