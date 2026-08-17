'use strict';

const { Events } = require('discord.js');

const config = require('./config');
const ids = require('./ids');

/**
 * ============================================================================
 *  RATING REACTIONS
 * ============================================================================
 *  Every post in the rating channel gets 1️⃣ through 5️⃣ added automatically, so
 *  members can score each other's edits without anyone having to seed the
 *  reactions by hand.
 *
 *  Only posts carrying an actual edit are reacted to, meaning an attachment or
 *  a link. Chat in the same channel is left alone, otherwise "nice one" ends up
 *  with a score attached to it.
 *
 *  Reactions are added one at a time with a gap between them. Discord's
 *  per-channel reaction limit is roughly one every 250ms, and firing five at
 *  once gets the last two dropped silently, which looks like the bot half
 *  working rather than like a rate limit.
 * ============================================================================
 */

const RATING = config.RATINGS;

/** A message is rateable if it carries a file or a link. */
function isRateable(message) {
  if (message.author?.bot) return false;
  if (message.attachments.size > 0) return true;
  if (!RATING.REQUIRE_MEDIA) return true;
  return /https?:\/\/\S+/i.test(message.content || '');
}

async function react(message) {
  for (const emoji of RATING.EMOJI) {
    try {
      await message.react(emoji);
    } catch (err) {
      // A deleted message or a missing Add Reactions permission both land here.
      // Stop rather than grinding through four more failures.
      console.error('[Ratings]', err.message);
      return;
    }
    await new Promise(r => setTimeout(r, RATING.DELAY_MS));
  }
}

function attach(client) {
  client.on(Events.MessageCreate, async message => {
    try {
      const channelId = ids.channelId('RATINGS');
      if (!channelId || message.channelId !== channelId) return;
      if (!isRateable(message)) return;
      await react(message);
    } catch (err) {
      console.error('[Ratings] handler:', err.message);
    }
  });

  console.log('[Ratings] Listener attached');
}

module.exports = { attach, isRateable, react };
