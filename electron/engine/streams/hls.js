'use strict';

// HLS (RFC 8216) playlist parsing: master playlists (variants and alternate
// audio) and media playlists (segments, AES-128 keys, fMP4 init sections,
// byte ranges).

function parseAttributes(text) {
  const attrs = {};
  for (const m of text.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) {
    attrs[m[1]] = m[2].startsWith('"') ? m[2].slice(1, -1) : m[2];
  }
  return attrs;
}

function parseByteRange(value, previousEnd) {
  if (!value) return null;
  const [length, offset] = value.split('@').map(Number);
  return { length, offset: Number.isFinite(offset) ? offset : previousEnd };
}

function parsePlaylist(text, baseUrl) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).map((l) => l.trim());
  if (lines[0] !== '#EXTM3U') throw new Error('Not an HLS playlist (missing #EXTM3U)');
  const resolve = (uri) => new URL(uri, baseUrl).href;

  if (lines.some((l) => l.startsWith('#EXT-X-STREAM-INF:'))) {
    const variants = [];
    const media = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('#EXT-X-STREAM-INF:')) {
        const a = parseAttributes(line.slice(18));
        let uri = lines[++i];
        while (uri !== undefined && (uri === '' || uri.startsWith('#'))) uri = lines[++i];
        if (!uri) break;
        const [width, height] = (a.RESOLUTION || '').split('x').map(Number);
        variants.push({
          uri: resolve(uri),
          bandwidth: Number(a['AVERAGE-BANDWIDTH'] || a.BANDWIDTH) || 0,
          width: width || null,
          height: height || null,
          codecs: a.CODECS || null,
          audio: a.AUDIO || null,
        });
      } else if (line.startsWith('#EXT-X-MEDIA:')) {
        const a = parseAttributes(line.slice(13));
        media.push({
          type: a.TYPE,
          groupId: a['GROUP-ID'],
          name: a.NAME,
          language: a.LANGUAGE || null,
          isDefault: a.DEFAULT === 'YES',
          uri: a.URI ? resolve(a.URI) : null,
        });
      }
    }
    return { type: 'master', variants, media };
  }

  const segments = [];
  let sequence = 0;
  let key = null;
  let map = null;
  let duration = 0;
  let byteRange = null;
  let lastEnd = 0;
  let endList = false;
  for (const line of lines) {
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) sequence = Number(line.slice(22)) || 0;
    else if (line.startsWith('#EXT-X-KEY:')) {
      const a = parseAttributes(line.slice(11));
      key =
        a.METHOD === 'NONE'
          ? null
          : { method: a.METHOD, uri: a.URI ? resolve(a.URI) : null, iv: a.IV || null };
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const a = parseAttributes(line.slice(11));
      map = { uri: resolve(a.URI), byteRange: parseByteRange(a.BYTERANGE, 0) };
    } else if (line.startsWith('#EXTINF:')) duration = parseFloat(line.slice(8)) || 0;
    else if (line.startsWith('#EXT-X-BYTERANGE:')) byteRange = parseByteRange(line.slice(17), lastEnd);
    else if (line === '#EXT-X-ENDLIST') endList = true;
    else if (line && !line.startsWith('#')) {
      segments.push({ uri: resolve(line), duration, key, map, sequence, byteRange });
      if (byteRange) lastEnd = byteRange.offset + byteRange.length;
      sequence++;
      duration = 0;
      byteRange = null;
    }
  }
  return { type: 'media', segments, endList };
}

// Picks a variant: 'best' (highest bitrate), 'worst', or a target height
// such as 720 (the tallest variant not above it).
function selectVariant(variants, quality = 'best') {
  if (!variants.length) throw new Error('The HLS master playlist lists no variants');
  const byBandwidth = [...variants].sort((a, b) => a.bandwidth - b.bandwidth);
  if (quality === 'worst') return byBandwidth[0];
  const height = Number(quality);
  if (Number.isFinite(height) && height > 0) {
    const fitting = byBandwidth.filter((v) => v.height && v.height <= height);
    if (fitting.length) return fitting[fitting.length - 1];
    return byBandwidth[0];
  }
  return byBandwidth[byBandwidth.length - 1];
}

function trackExtension(segments, type) {
  if (segments.some((s) => s.map)) return type === 'audio' ? '.m4a' : '.mp4';
  const ext = (new URL(segments[0]?.uri || 'x:/a.ts').pathname.match(/\.(\w+)$/) || [])[1];
  if (ext === 'aac') return '.aac';
  if (ext === 'mp3') return '.mp3';
  return '.ts';
}

function checkMedia(playlist) {
  if (!playlist.endList) {
    throw Object.assign(new Error('Live streams cannot be downloaded yet (the playlist has no end)'), {
      fatal: true,
    });
  }
  const method = playlist.segments.find((s) => s.key && s.key.method !== 'AES-128')?.key.method;
  if (method) {
    throw Object.assign(new Error(`This stream is DRM-protected (${method}) and cannot be downloaded`), {
      fatal: true,
    });
  }
  if (!playlist.segments.length) throw new Error('The HLS playlist contains no segments');
}

// Resolves a URL to the list of tracks to download. fetchText(url) returns
// the playlist body.
async function resolveHls(url, fetchText, quality) {
  const root = parsePlaylist(await fetchText(url), url);
  const durationOf = (segments) => segments.reduce((sum, s) => sum + s.duration, 0);
  if (root.type === 'media') {
    checkMedia(root);
    return {
      info: { duration: durationOf(root.segments) },
      tracks: [{ type: 'main', segments: root.segments, ext: trackExtension(root.segments) }],
    };
  }
  const variant = selectVariant(root.variants, quality);
  const video = parsePlaylist(await fetchText(variant.uri), variant.uri);
  checkMedia(video);
  const tracks = [{ type: 'main', segments: video.segments, ext: trackExtension(video.segments) }];

  if (variant.audio) {
    const group = root.media.filter((m) => m.type === 'AUDIO' && m.groupId === variant.audio && m.uri);
    const chosen = group.find((m) => m.isDefault) || group[0];
    if (chosen) {
      const audio = parsePlaylist(await fetchText(chosen.uri), chosen.uri);
      checkMedia(audio);
      tracks[0].type = 'video';
      tracks.push({ type: 'audio', segments: audio.segments, ext: trackExtension(audio.segments, 'audio') });
    }
  }
  return {
    info: { width: variant.width, height: variant.height, bandwidth: variant.bandwidth, duration: durationOf(video.segments) },
    tracks,
  };
}

// The IV is explicit in the key tag or, per RFC 8216, the media sequence
// number as a 128-bit big-endian integer.
function segmentIv(segment) {
  if (segment.key.iv) {
    return Buffer.from(segment.key.iv.replace(/^0x/i, '').padStart(32, '0'), 'hex');
  }
  const iv = Buffer.alloc(16);
  iv.writeBigUInt64BE(BigInt(segment.sequence), 8);
  return iv;
}

// What the Add dialog shows before a stream is downloaded: the qualities on
// offer, the duration and whether audio comes as a separate track.
async function probeHls(url, fetchText) {
  const root = parsePlaylist(await fetchText(url), url);
  let media = root;
  let qualities = [];
  let separateAudio = false;
  if (root.type === 'master') {
    qualities = [...new Map(root.variants.filter((v) => v.height).map((v) => [v.height, v])).values()]
      .sort((a, b) => b.height - a.height)
      .map((v) => ({ height: v.height, width: v.width, bandwidth: v.bandwidth }));
    const best = selectVariant(root.variants);
    separateAudio = Boolean(best.audio && root.media.some((m) => m.type === 'AUDIO' && m.groupId === best.audio && m.uri));
    media = parsePlaylist(await fetchText(best.uri), best.uri);
  }
  checkMedia(media);
  const duration = media.segments.reduce((sum, s) => sum + s.duration, 0);
  return { qualities, duration, segments: media.segments.length, separateAudio };
}

module.exports = { parsePlaylist, parseAttributes, selectVariant, resolveHls, segmentIv, probeHls };
