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
 * ============================================================================
 */

const TOP_N = 20;

/**
 * Aggregate lifetime earnings per editor across every campaign.
 * Uses the earnings ledger rather than submissions, so referral bonuses and
 * manual adjustments count too.
 */
async function rebuild() {
  const rows = await getDb().collection('earnings').aggregate([
    { $match: { state: { $in: ['pending', 'cleared', 'paid'] } } },
    { $group: { _id: '$userId', total: { $sum: '$amount' } } },
    { $match: { total: { $gt: 0 } } },
    { $sort: { total: -1 } },
    { $limit: TOP_N },
  ]).toArray();

  // Attach a display name for each. One indexed lookup per row, capped at 20.
  const enriched = [];
  for (const row of rows) {
    const editor = await getDb().collection('editors').findOne(
      { userId: row._id }, { projection: { username: 1, displayName: 1 } });
    enriched.push({
      userId: row._id,
      name: editor?.username || editor?.displayName || 'unknown',
      total: row.total,
    });
  }

  await setMeta('allTimeLeaderboard', { rows: enriched, updatedAt: new Date() });
  return enriched;
}

function buildEmbed(rows, updatedAt) {
  const body = rows.length
    ? rows.map((r, i) =>
        `${String(i + 1).padStart(2, ' ')}. \`${r.name}\` - $${r.total.toFixed(2)}`
      ).join('\n')
    : copy.leaderboard.allTimeEmpty;

  return new EmbedBuilder()
    .setColor(config.BRAND_COLOR)
    .setTitle(copy.leaderboard.allTimeTitle)
    .setDescription('```\n' + body.slice(0, 3900) + '\n```')
    .setFooter({ text: copy.leaderboard.allTimeFooter(
      updatedAt ? new Date(updatedAt).toUTCString() : 'never') })
    .setTimestamp(updatedAt ? new Date(updatedAt) : new Date());
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
