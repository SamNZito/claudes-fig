'use strict';
// Where a song is coming from, as links people can open: the page of the upload that is actually
// playing (SoundCloud), and the Spotify song it was matched to (when Spotify was used to look it up).
// Used by the "Now playing" chat line, /nowplaying, the logs and the live page.

const SITES = [
  [/(^|\.)soundcloud\.com$|^snd\.sc$/, 'SoundCloud'],
  [/(^|\.)spotify\.com$/, 'Spotify'],
  [/(^|\.)bandcamp\.com$/, 'Bandcamp'],
  [/(^|\.)youtube\.com$|^youtu\.be$/, 'YouTube'],
];

/** Only plain https web pages (never api.* addresses or anything else). */
function webUrl(u) {
  try {
    const url = new URL(String(u || ''));
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (/^api(-v2)?\./.test(url.hostname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function siteName(u) {
  try {
    const host = new URL(u).hostname.replace(/^www\.|^m\./, '');
    for (const [re, name] of SITES) if (re.test(host)) return name;
    return host;
  } catch {
    return 'the web';
  }
}

/** { playing: {site, url} | null, spotify: url | null } for a queue entry that has started. */
function sourceLinks(entry) {
  const page = webUrl(entry?.pageUrl) || webUrl(entry?.url);
  const spotify = webUrl(entry?.meta?.url);
  return { playing: page ? { site: siteName(page), url: page } : null, spotify: spotify && siteName(spotify) === 'Spotify' ? spotify : null };
}

/** " · [SoundCloud](<url>) · [Spotify match](<url>)". The <> stop Discord from adding big previews. */
function chatLinks(entry) {
  const { playing, spotify } = sourceLinks(entry);
  const parts = [];
  if (playing) parts.push(`[${playing.site}](<${playing.url}>)`);
  if (spotify) parts.push(`[Spotify match](<${spotify}>)`);
  return parts.length ? ` · ${parts.join(' · ')}` : '';
}

module.exports = { sourceLinks, chatLinks, siteName, webUrl };
