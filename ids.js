'use strict';

const config = require('./config');
const { getMeta, setMeta } = require('./db');

/**
 * ============================================================================
 *  ID RESOLUTION
 * ============================================================================
 *  Every channel and role ID has two possible homes:
 *
 *    1. config.js  — hand-pasted, the source of truth when it is filled in
 *    2. MongoDB    — written by /setup when the bot creates something itself
 *
 *  Mongo wins, because if the bot created the channel it knows the real ID and
 *  config.js still says SET_ME. This is what lets /setup provision a server the
 *  bot has never seen without anyone editing a file and redeploying.
 *
 *  Nothing else in the codebase should read config.CHANNELS directly. Call
 *  channelId()/roleId() so the Mongo override is always respected.
 * ============================================================================
 */

const isUnset = v => !v || String(v).startsWith('SET_ME');

// Cache so we are not hitting Mongo on every interaction. Populated at boot by
// warm(), invalidated whenever /setup writes a new ID.
let cache = new Map();

async function warm() {
  const stored = await getMeta('resolvedIds', {});
  cache = new Map(Object.entries(stored || {}));
  return cache.size;
}

async function remember(key, id) {
  cache.set(key, id);
  await setMeta('resolvedIds', Object.fromEntries(cache));
}

/**
 * Resolve a channel key such as 'PAYMENTS' or a log key such as 'LOG:SYSTEM'.
 * Returns null when it is genuinely not configured anywhere, so callers can
 * skip quietly rather than throwing.
 */
function channelId(key) {
  const stored = cache.get(`CHANNEL:${key}`);
  if (!isUnset(stored)) return stored;

  const fromConfig = key.startsWith('LOG:')
    ? config.LOG_CHANNELS[key.slice(4)]
    : config.CHANNELS[key];

  return isUnset(fromConfig) ? null : fromConfig;
}

function roleId(key) {
  const stored = cache.get(`ROLE:${key}`);
  if (!isUnset(stored)) return stored;
  const fromConfig = config.ROLES[key];
  return isUnset(fromConfig) ? null : fromConfig;
}

/** Resolve a niche's role ID, checking Mongo first. */
function nicheRoleId(value) {
  const stored = cache.get(`NICHE:${value}`);
  if (!isUnset(stored)) return stored;
  const niche = config.NICHES.find(n => n.value === value);
  return niche && !isUnset(niche.roleId) ? niche.roleId : null;
}

function nicheByValue(value) {
  return config.NICHES.find(n => n.value === value) || null;
}

/** Everything still unresolved, for the boot warning and /setup's report. */
function missing() {
  const out = [];
  for (const key of Object.keys(config.CHANNELS)) {
    if (!channelId(key)) out.push(`CHANNELS.${key}`);
  }
  for (const key of Object.keys(config.LOG_CHANNELS)) {
    if (!channelId(`LOG:${key}`)) out.push(`LOG_CHANNELS.${key}`);
  }
  for (const key of Object.keys(config.ROLES)) {
    if (!roleId(key)) out.push(`ROLES.${key}`);
  }
  for (const n of config.NICHES) {
    if (!nicheRoleId(n.value)) out.push(`NICHES.${n.value}`);
  }
  return out;
}

module.exports = {
  warm, remember, channelId, roleId, nicheRoleId, nicheByValue, missing, isUnset,
};
