'use strict';

const { GridFSBucket } = require('mongodb');
const { AttachmentBuilder } = require('discord.js');

const config = require('./config');
const { getDb } = require('./db');

/**
 * ============================================================================
 *  CAMPAIGN ASSETS (audio files, example videos)
 * ============================================================================
 *  Why the bytes live in MongoDB rather than a Discord link:
 *
 *  Discord attachment URLs are signed and expire in roughly 24 hours. Storing
 *  the URL means the campaign post looks fine on day one and shows a dead link
 *  on day two, which is exactly the failure you would not notice until an
 *  editor complains a week in.
 *
 *  So /campaign create downloads the attachment once, streams it into GridFS,
 *  and every re-post re-uploads from there. GridFS rather than a plain document
 *  because a 16MB BSON limit does not fit a 25MB example video.
 * ============================================================================
 */

const BUCKET = 'campaignAssets';

function bucket() {
  return new GridFSBucket(getDb(), { bucketName: BUCKET });
}

const MAX_BYTES = config.CAMPAIGN_AUTOMATION.MAX_ASSET_MB * 1024 * 1024;

/**
 * Pull a Discord attachment down and store it. Returns a descriptor to save on
 * the campaign document, or throws with a message safe to show staff.
 */
async function store(campaignValue, attachment) {
  if (attachment.size > MAX_BYTES) {
    throw new Error(
      `${attachment.name} is ${(attachment.size / 1048576).toFixed(1)}MB. ` +
      `The limit is ${config.CAMPAIGN_AUTOMATION.MAX_ASSET_MB}MB.`);
  }

  const res = await fetch(attachment.url);
  if (!res.ok) throw new Error(`Could not download ${attachment.name} from Discord.`);
  const buffer = Buffer.from(await res.arrayBuffer());

  // Re-check after download. attachment.size is what Discord claims, not
  // necessarily what arrived.
  if (buffer.length > MAX_BYTES) {
    throw new Error(`${attachment.name} is larger than ${config.CAMPAIGN_AUTOMATION.MAX_ASSET_MB}MB.`);
  }

  const id = await new Promise((resolve, reject) => {
    const upload = bucket().openUploadStream(attachment.name, {
      metadata: {
        campaignValue,
        contentType: attachment.contentType || 'application/octet-stream',
        uploadedAt: new Date(),
      },
    });
    upload.on('error', reject);
    upload.on('finish', () => resolve(upload.id));
    upload.end(buffer);
  });

  return {
    fileId: id,
    name: attachment.name,
    size: buffer.length,
    contentType: attachment.contentType || null,
  };
}

/** Rebuild Discord attachments from stored bytes, ready to post again. */
async function load(assets = []) {
  const out = [];
  for (const asset of assets) {
    try {
      const chunks = [];
      const stream = bucket().openDownloadStream(asset.fileId);
      await new Promise((resolve, reject) => {
        stream.on('data', c => chunks.push(c));
        stream.on('error', reject);
        stream.on('end', resolve);
      });
      out.push(new AttachmentBuilder(Buffer.concat(chunks), { name: asset.name }));
    } catch (err) {
      console.error(`[Assets] ${asset.name} would not load:`, err.message);
    }
  }
  return out;
}

/** Remove every asset for a campaign. Called when a campaign is deleted. */
async function purge(campaignValue) {
  const files = await getDb().collection(`${BUCKET}.files`)
    .find({ 'metadata.campaignValue': campaignValue }).toArray();
  for (const f of files) {
    await bucket().delete(f._id).catch(() => {});
  }
  return files.length;
}

module.exports = { store, load, purge, MAX_BYTES };
