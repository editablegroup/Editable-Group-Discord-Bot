'use strict';

const config = require('./config');

/**
 * ============================================================================
 *  TIKTOK DATA LAYER
 * ============================================================================
 *  Your current bot sends every single lookup straight to paid RapidAPI, with
 *  hardcoded response paths that fail silently when the shape changes.
 *
 *  This version uses a three-stage chain, cheapest first — the same pattern
 *  the PayPerClip pitch repo used, and the single most valuable idea in it:
 *
 *    1. TikTok oEmbed   — free, official, no key. Gives author handle,
 *                         thumbnail, caption. No view counts.
 *    2. TikWM           — free, unofficial. Gives views + likes.
 *    3. RapidAPI        — paid. Only reached when 1 and 2 both fail.
 *
 *  At 3 campaigns and 100 editors the cost difference is noise. At 2,000
 *  editors submitting to open campaigns, every approved post is re-checked
 *  every 12 hours forever. 5,000 submissions × 2 runs/day × 30 days = 300,000
 *  RapidAPI calls a month. That is well past any reasonable RapidAPI tier.
 *  Free-first keeps the paid calls for the handful that genuinely need them.
 *
 *  The oEmbed step also unlocks something you currently cannot do at all:
 *  verifying that a submitted video actually belongs to the editor submitting
 *  it. See verifyOwnership() below.
 * ============================================================================
 */

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
const RAPIDAPI_HOST = 'tiktok-api23.p.rapidapi.com';

// Simple counters so you can see what the chain is actually costing you.
const usage = { oembed: 0, tikwm: 0, rapidapi: 0, failures: 0 };
function getUsage() { return { ...usage }; }
function resetUsage() { for (const k of Object.keys(usage)) usage[k] = 0; }

// ── Fetch with timeout ──────────────────────────────────────────────────────

async function fetchJson(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── URL handling ────────────────────────────────────────────────────────────

function normalizeUrl(url) {
  if (!url) return '';
  let u = url.trim().split('?')[0];
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u;
}

function isTikTokUrl(url) {
  return /(?:^|\.)(tiktok\.com|vm\.tiktok\.com|vt\.tiktok\.com)/i.test(
    (() => { try { return new URL(normalizeUrl(url)).hostname; } catch { return ''; } })()
  );
}

/** Extract the numeric video ID, resolving short links if needed. */
async function extractVideoId(url) {
  const clean = normalizeUrl(url);
  const direct = clean.match(/\/video\/(\d+)/) || clean.match(/\/photo\/(\d+)/);
  if (direct) return direct[1];

  // Short link (vm./vt.) — follow the redirect.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(clean, { method: 'HEAD', redirect: 'follow', signal: controller.signal });
    const m = res.url.match(/\/(?:video|photo)\/(\d+)/);
    return m ? m[1] : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Recursively hunt for a numeric key. Borrowed as an *idea*, not as code:
 * RapidAPI providers reshuffle their response envelopes without warning, and
 * your current hardcoded `data.itemList[0].stats.playCount` path returns null
 * the moment they do — silently, so every editor's views freeze at 0 and you
 * find out from angry DMs.
 */
function findNumericKey(obj, keys, depth = 0) {
  if (depth > 6 || obj === null || typeof obj !== 'object') return undefined;
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (keys.includes(k)) {
      const n = typeof v === 'string' ? parseInt(v, 10) : v;
      if (typeof n === 'number' && Number.isFinite(n)) return n;
    }
    const nested = findNumericKey(v, keys, depth + 1);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

// ── Stage 1: oEmbed (free, official) ────────────────────────────────────────

async function fetchOEmbed(url) {
  const data = await fetchJson(
    `https://www.tiktok.com/oembed?url=${encodeURIComponent(normalizeUrl(url))}`
  );
  if (!data) return null;
  usage.oembed++;
  return {
    handle: (data.author_unique_id || '').toLowerCase().replace(/^@/, '') || null,
    authorName: data.author_name || null,
    thumbnailUrl: data.thumbnail_url || null,
    caption: data.title || null,
  };
}

// ── Stage 2: TikWM (free, unofficial) ───────────────────────────────────────

async function fetchTikwm(url) {
  const data = await fetchJson(
    `https://www.tikwm.com/api/?url=${encodeURIComponent(normalizeUrl(url))}`
  );
  if (!data || data.code !== 0 || !data.data) return null;
  usage.tikwm++;
  const d = data.data;
  return {
    views: parseInt(d.play_count, 10) || 0,
    likes: parseInt(d.digg_count, 10) || 0,
    comments: parseInt(d.comment_count, 10) || 0,
    shares: parseInt(d.share_count, 10) || 0,
    createTime: d.create_time ? parseInt(d.create_time, 10) : null,
    handle: (d.author?.unique_id || '').toLowerCase() || null,
    thumbnailUrl: d.cover || null,
    caption: d.title || null,
  };
}

// ── Stage 3: RapidAPI (paid, last resort) ───────────────────────────────────

async function fetchRapidApi(videoId) {
  if (!RAPIDAPI_KEY || !videoId) return null;
  const data = await fetchJson(
    `https://${RAPIDAPI_HOST}/api/post/detail?videoId=${videoId}`,
    { headers: { 'x-rapidapi-key': RAPIDAPI_KEY, 'x-rapidapi-host': RAPIDAPI_HOST } }
  );
  if (!data) return null;
  usage.rapidapi++;

  const item = data?.itemInfo?.itemStruct || data?.itemList?.[0] || data;
  const views = findNumericKey(item, ['playCount', 'play_count']) ?? 0;
  const likes = findNumericKey(item, ['diggCount', 'digg_count', 'like_count']) ?? 0;
  const createTime = findNumericKey(item, ['createTime', 'create_time']) ?? null;
  const handle = (item?.author?.uniqueId || item?.author?.unique_id || '').toLowerCase() || null;

  if (!views && !likes && !handle) return null;
  return { views, likes, createTime, handle, comments: 0, shares: 0 };
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Full metadata for a URL. Used at SUBMISSION time — we want the handle and
 * thumbnail here so the editor sees a preview and we can verify ownership.
 */
async function getVideoDetails(url) {
  if (!isTikTokUrl(url)) return { ok: false, reason: 'not_tiktok' };

  const videoId = await extractVideoId(url);
  if (!videoId) return { ok: false, reason: 'unresolvable' };

  const [oembed, tikwm] = await Promise.all([
    fetchOEmbed(url).catch(() => null),
    fetchTikwm(url).catch(() => null),
  ]);

  let stats = tikwm;
  if (!stats || (stats.views === 0 && stats.likes === 0)) {
    const rapid = await fetchRapidApi(videoId).catch(() => null);
    if (rapid) stats = { ...(stats || {}), ...rapid };
  }

  if (!stats && !oembed) {
    usage.failures++;
    return { ok: false, reason: 'lookup_failed', videoId };
  }

  return {
    ok: true,
    videoId,
    url: normalizeUrl(url),
    handle: oembed?.handle || stats?.handle || null,
    authorName: oembed?.authorName || null,
    thumbnailUrl: oembed?.thumbnailUrl || stats?.thumbnailUrl || null,
    caption: oembed?.caption || stats?.caption || null,
    views: stats?.views ?? 0,
    likes: stats?.likes ?? 0,
    comments: stats?.comments ?? 0,
    shares: stats?.shares ?? 0,
    createTime: stats?.createTime ?? null,
  };
}

/**
 * Views/likes only. Used by the 12-hourly refresh loop, which runs over every
 * approved submission — so it skips oEmbed entirely to halve the request count.
 */
async function getVideoStats(url, videoId) {
  const tikwm = await fetchTikwm(url).catch(() => null);
  if (tikwm && (tikwm.views > 0 || tikwm.likes > 0)) return tikwm;
  const rapid = await fetchRapidApi(videoId || await extractVideoId(url)).catch(() => null);
  if (rapid) return rapid;
  usage.failures++;
  return null;
}

/**
 * Does this video belong to the editor who submitted it?
 *
 * This is the check that makes an open server viable. Right now anyone can
 * paste any viral TikTok — including someone else's — and it counts toward
 * their payout. Nothing in the current code stops it. With 100 hand-picked
 * people you'd notice. With 2,000 strangers and a $1,000 pot, someone will try
 * it in the first hour.
 */
function verifyOwnership(videoHandle, registeredHandle) {
  if (!config.INTEGRITY.ENFORCE_HANDLE_MATCH) return { ok: true };
  if (!registeredHandle) return { ok: false, reason: 'no_registered_handle' };
  if (!videoHandle) return { ok: false, reason: 'handle_unavailable' };

  const a = videoHandle.toLowerCase().replace(/^@/, '').trim();
  const b = registeredHandle.toLowerCase().replace(/^@/, '').trim();
  if (a === b) return { ok: true };
  return { ok: false, reason: 'handle_mismatch', videoHandle: a, registeredHandle: b };
}

/** Pull a bare @handle out of whatever the editor pasted at onboarding. */
function parseHandle(input) {
  if (!input) return null;
  const s = input.trim();
  const fromUrl = s.match(/tiktok\.com\/@([A-Za-z0-9._]+)/i);
  if (fromUrl) return fromUrl[1].toLowerCase();
  const bare = s.match(/^@?([A-Za-z0-9._]{2,24})$/);
  return bare ? bare[1].toLowerCase() : null;
}

module.exports = {
  normalizeUrl, isTikTokUrl, extractVideoId,
  getVideoDetails, getVideoStats,
  verifyOwnership, parseHandle,
  getUsage, resetUsage,
};
