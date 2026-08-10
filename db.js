'use strict';

const { MongoClient } = require('mongodb');
const config = require('./config');

let db = null;
let mongoClient = null;

/**
 * Connect and — critically — build indexes.
 *
 * Your current bot has ZERO indexes. Every /leaderboard, /earnings and
 * /mysubmissions is a full collection scan. At 200 submissions nobody notices.
 * At 20,000 submissions (which one open campaign with 2,000 editors will
 * produce) those queries take seconds each and will pin the CPU on a $5 box.
 *
 * These indexes are the difference between the bot surviving launch week and
 * timing out on every interaction.
 */
async function connect() {
  mongoClient = new MongoClient(config.MONGODB_URI, {
    maxPoolSize: 10,
    minPoolSize: 1,
    serverSelectionTimeoutMS: 10_000,
  });
  await mongoClient.connect();
  db = mongoClient.db(config.DB_NAME);
  console.log('[DB] Connected');
  await ensureIndexes();
  await seedLegacyCampaigns();
  return db;
}

async function ensureIndexes() {
  const jobs = [
    // Submissions — the hot collection.
    db.collection('submissions').createIndex({ userId: 1, campaignValue: 1 }),
    db.collection('submissions').createIndex({ campaignValue: 1, status: 1 }),
    db.collection('submissions').createIndex({ status: 1, lastUpdated: 1 }),
    db.collection('submissions').createIndex({ submittedAt: -1 }),

    // Duplicate-link protection. A partial unique index means the same TikTok
    // video can never be submitted twice to the same campaign — by anyone.
    // Neither your bot nor PayPerClip's has this. It is the easiest way for a
    // stranger to steal money from you, and this closes it at the DB level so
    // it holds even if application logic is bypassed.
    db.collection('submissions').createIndex(
      { campaignValue: 1, videoId: 1 },
      { unique: true, partialFilterExpression: { videoId: { $type: 'string' } } }
    ),

    // Editors
    db.collection('editors').createIndex({ userId: 1 }, { unique: true }),
    db.collection('editors').createIndex({ tiktokHandle: 1 }),
    db.collection('editors').createIndex({ tier: 1 }),

    // Campaigns
    db.collection('campaigns').createIndex({ value: 1 }, { unique: true }),
    db.collection('campaigns').createIndex({ status: 1, tier: 1 }),

    // Denormalised leaderboard — precomputed, read-only for the bot's hot path.
    db.collection('leaderboards').createIndex({ campaignValue: 1 }, { unique: true }),

    // Append-only earnings ledger.
    db.collection('earnings').createIndex({ userId: 1, campaignValue: 1 }),
    db.collection('earnings').createIndex({ userId: 1, state: 1 }),

    db.collection('payoutRequests').createIndex({ userId: 1, status: 1 }),
    db.collection('payoutRequests').createIndex({ status: 1, createdAt: -1 }),

    db.collection('referrals').createIndex({ inviteeId: 1 }),
    db.collection('referrals').createIndex({ inviterId: 1 }),

    db.collection('metadata').createIndex({ key: 1 }, { unique: true }),

    // Onboarding state moves OUT of process memory and into Mongo, with a TTL.
    // Right now a Railway redeploy mid-onboarding strands the user in a broken
    // half-finished state with no way to restart.
    db.collection('onboardingState').createIndex({ userId: 1 }, { unique: true }),
    db.collection('onboardingState').createIndex(
      { updatedAt: 1 }, { expireAfterSeconds: 3600 }
    ),
  ];

  const results = await Promise.allSettled(jobs);
  const failed = results.filter(r => r.status === 'rejected');
  if (failed.length) {
    // A duplicate-key error here means you already have duplicate submissions
    // in the DB. See the "Before you deploy" notes — clean them first.
    for (const f of failed) console.error('[DB] Index failed:', f.reason?.message);
  }
  console.log(`[DB] Indexes ready (${results.length - failed.length}/${results.length})`);
}

async function seedLegacyCampaigns() {
  const count = await db.collection('campaigns').countDocuments();
  if (count > 0) return;
  await db.collection('campaigns').insertMany(
    config.LEGACY_CAMPAIGNS.map(c => ({ ...c, createdAt: new Date(), seeded: true }))
  );
  console.log(`[DB] Seeded ${config.LEGACY_CAMPAIGNS.length} legacy campaigns`);
}

// ── Small helpers used across modules ────────────────────────────────────────

async function getMeta(key, fallback = null) {
  const doc = await db.collection('metadata').findOne({ key });
  return doc ? doc.value : fallback;
}

async function setMeta(key, value) {
  await db.collection('metadata').updateOne(
    { key }, { $set: { value, updatedAt: new Date() } }, { upsert: true }
  );
}

function getDb() {
  if (!db) throw new Error('DB not connected — call connect() first');
  return db;
}

async function close() {
  if (mongoClient) await mongoClient.close();
}

module.exports = { connect, getDb, getMeta, setMeta, close };
