"use strict";

const FREE_CHAT_DAILY_LIMIT = 15;

function utcDay(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

async function initializeChatQuota(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS decision_chat_daily_usage (
      uid TEXT NOT NULL,
      day DATE NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (uid, day),
      CONSTRAINT chat_usage_nonnegative CHECK (used >= 0)
    )
  `);
}

async function reserveFreeChat(pool, uid, day = utcDay()) {
  if (typeof uid !== "string" || !uid.trim()) {
    throw new Error("Authenticated UID required");
  }

  const result = await pool.query(`
    INSERT INTO decision_chat_daily_usage (uid, day, used)
    VALUES ($1, $2::date, 1)
    ON CONFLICT (uid, day)
    DO UPDATE SET used = decision_chat_daily_usage.used + 1
    WHERE decision_chat_daily_usage.used < $3
    RETURNING used
  `, [uid, day, FREE_CHAT_DAILY_LIMIT]);

  if (result.rowCount === 0) {
    return {
      allowed: false,
      remaining: 0,
      limit: FREE_CHAT_DAILY_LIMIT,
    };
  }

  return {
    allowed: true,
    remaining: Math.max(
      0,
      FREE_CHAT_DAILY_LIMIT - Number(result.rows[0].used)
    ),
    limit: FREE_CHAT_DAILY_LIMIT,
  };
}

async function releaseFreeChat(pool, uid, day) {
  await pool.query(`
    UPDATE decision_chat_daily_usage
    SET used = GREATEST(used - 1, 0)
    WHERE uid = $1 AND day = $2::date
  `, [uid, day]);
}

module.exports = {
  FREE_CHAT_DAILY_LIMIT,
  utcDay,
  initializeChatQuota,
  reserveFreeChat,
  releaseFreeChat,
};
