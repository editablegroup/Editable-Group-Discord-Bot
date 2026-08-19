'use strict';

const { EmbedBuilder } = require('discord.js');

const config = require('./config');
const copy = require('./copy');
const ids = require('./ids');
const { getDb, getMeta, setMeta } = require('./db');

/**
 * ============================================================================
 *  ALL TIME LEADERBOARD
 * ============================================================================
 *  One message in #leaderboard, edited in place, rebuilt every time a campaign
 *  ends. Ranked by money earned, because that is the number editors care about
 *  and the one that cannot be inflated by posting more often.
 *
 *  Deliberately no post count in brackets. Views are a means to the dollar
 *  figure, and showing three numbers per row makes the board harder to read at
 *  a glance than showing one.
 *
 *  Rebuilt on campaign end rather than on every stats run: the numbers only
 *  become final when a campaign closes, and editing one message every 3 hours
 *  forever is a rate limit you do not need to spend.
 *  The 2026 manual baseline is merged before newer ledger rows are ranked.
 * ============================================================================
 */

const TOP_N = config.LEADERBOARD.TOP_N;

/**
 * Aggregate lifetime earnings per editor across every campaign.
 * Uses the earnings ledger rather than submissions, so referral bonuses and
 * manual adjustments count too.
 */
async function rebuild() {
  const totals = new Map(config.LEADERBOARD.MANUAL_TOTALS.map(row => [
    row.userId, { ...row },
  ]));

  // The supplied historical totals must still publish if old ledger data is
  // missing or malformed. Newer earnings are an optional addition, not a
  // dependency for the board itself.
  try {
    const ledgerRows = await getDb().collection('earnings').aggregate([
      { $match: {
          state: { $in: ['pending', 'cleared', 'paid'] },
          createdAt: { $gte: config.LEADERBOARD.BASELINE_CUTOFF },
      } },
      { $group: { _id: '$userId', total: { $sum: '$amount' } } },
      { $match: { total: { $gt: 0 } } },
    ]).toArray();

    for (const row of ledgerRows) {
      const existing = totals.get(row._id);
      if (existing) existing.total += row.total;
      else totals.set(row._id, { userId: row._id, name: null, total: row.total });
    }
  } catch (err) {
    console.error('[Leaderboard] New earnings merge skipped:', err.message);
  }

  const rows = [...totals.values()]
    .filter(row => row.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, TOP_N);

  // Manual rows already have names. New earners need one indexed editor lookup.
  const enriched = [];
  for (const row of rows) {
    const editor = row.name ? null : await getDb().collection('editors').findOne(
      { userId: row.userId }, { projection: { username: 1, displayName: 1 } });
    enriched.push({
      userId: row.userId,
      name: row.name || editor?.username || editor?.displayName || 'unknown',
      total: row.total,
    });
  }

  await setMeta('allTimeLeaderboard', { rows: enriched, updatedAt: new Date() });
  return enriched;
}

function buildEmbed(rows, updatedAt) {
  const body = rows.length
    ? rows.map((r, i) =>
        `${i + 1}. \`${r.name}\` - **$${r.total.toLocaleString('en-US', {
          minimumFractionDigits: 2, maximumFractionDigits: 2 })}**`
      ).join('\n')
    : copy.leaderboard.allTimeEmpty;

  return new EmbedBuilder()
    .setColor(config.LEADERBOARD.COLOR)
    .setTitle(copy.leaderboard.allTimeTitle)
    .setDescription(body.slice(0, 3900))
    .setFooter({ text: copy.leaderboard.allTimeFooter(
      updatedAt ? formatUtc(updatedAt) : 'never') })
    .setTimestamp(updatedAt ? new Date(updatedAt) : new Date());
}

function formatUtc(value) {
  const date = new Date(value);
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][date.getUTCMonth()];
  const time = [date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()]
    .map(n => String(n).padStart(2, '0')).join(':');
  return `${month} ${date.getUTCDate()}, ${date.getUTCFullYear()} ${time} UTC`;
}

/**
 * Post or edit the single persistent message in #leaderboard.
 * Rebuilds the data first unless you pass { rebuild: false }.
 */
async function publish(client, { rebuild: shouldRebuild = true } = {}) {
  try {
    const channelId = ids.channelId('LEADERBOARD');
    if (!channelId) return;

    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) return;

    if (shouldRebuild) await rebuild();
    const stored = await getMeta('allTimeLeaderboard', { rows: [], updatedAt: null });
    const payload = { embeds: [buildEmbed(stored.rows || [], stored.updatedAt)] };

    const saved = await getMeta('leaderboardMessageId');
    if (saved) {
      const msg = await channel.messages.fetch(saved).catch(() => null);
      if (msg) { await msg.edit(payload); return; }
    }
    const msg = await channel.send(payload);
    await setMeta('leaderboardMessageId', msg.id);
    console.log('[Leaderboard] All-time board posted');
  } catch (err) {
    console.error('[Leaderboard] publish:', err.message);
  }
}

module.exports = { rebuild, buildEmbed, publish, TOP_N };
