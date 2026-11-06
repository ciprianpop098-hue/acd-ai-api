"use strict";

const crypto = require("node:crypto");

const FREE_DAILY_LIMIT = 15;
const PENDING_TTL_MINUTES = 15;

function utcDay(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function validateUid(uid) {
  if (
    typeof uid !== "string" ||
    !uid.trim() ||
    uid.length > 128
  ) {
    throw new Error("Invalid authenticated UID");
  }
}

async function initializeChatQuotaV2(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS acd_chat_reservations_v2 (
      id UUID PRIMARY KEY,
      uid TEXT NOT NULL,
      day DATE NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finalized_at TIMESTAMPTZ,
      CONSTRAINT acd_chat_v2_state_valid CHECK (
        state IN ('pending', 'completed', 'released')
      )
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS acd_chat_v2_usage_idx
    ON acd_chat_reservations_v2 (uid, day, state)
  `);
}

async function reserveFreeChatV2(
  pool,
  uid,
  day = utcDay()
) {
  validateUid(uid);

  if (
    typeof day !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(day)
  ) {
    throw new Error("Invalid UTC day");
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Serialize quota checks for the same user and UTC day.
    await client.query(
      `SELECT pg_advisory_xact_lock(
        hashtext($1::text),
        hashtext($2::text)
      )`,
      [uid, day]
    );

    const usage = await client.query(
      `
      SELECT COUNT(*)::integer AS used
      FROM acd_chat_reservations_v2
      WHERE uid = $1
        AND day = $2::date
        AND (
          state = 'completed'
          OR (
            state = 'pending'
            AND created_at >
              NOW() - INTERVAL '15 minutes'
          )
        )
      `,
      [uid, day]
    );

    const used = Number(usage.rows[0]?.used || 0);

    if (used >= FREE_DAILY_LIMIT) {
      await client.query("COMMIT");

      return {
        allowed: false,
        reservationId: null,
        remaining: 0,
        limit: FREE_DAILY_LIMIT,
      };
    }

    const reservationId = crypto.randomUUID();

    await client.query(
      `
      INSERT INTO acd_chat_reservations_v2
        (id, uid, day, state)
      VALUES ($1::uuid, $2, $3::date, 'pending')
      `,
      [reservationId, uid, day]
    );

    await client.query("COMMIT");

    return {
      allowed: true,
      reservationId,
      remaining: FREE_DAILY_LIMIT - used - 1,
      limit: FREE_DAILY_LIMIT,
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}

    throw error;
  } finally {
    client.release();
  }
}

async function settleFreeChatV2(
  pool,
  uid,
  reservationId,
  succeeded
) {
  validateUid(uid);

  if (
    typeof reservationId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      .test(reservationId)
  ) {
    throw new Error("Invalid reservation ID");
  }

  if (typeof succeeded !== "boolean") {
    throw new Error("Invalid reservation outcome");
  }

  const newState = succeeded
    ? "completed"
    : "released";

  const result = await pool.query(
    `
    UPDATE acd_chat_reservations_v2
    SET state = $3,
        finalized_at = NOW()
    WHERE id = $1::uuid
      AND uid = $2
      AND state = 'pending'
      AND created_at >
        NOW() - INTERVAL '15 minutes'
    RETURNING id
    `,
    [reservationId, uid, newState]
  );

  return {
    transitioned: result.rowCount === 1,
    state: newState,
  };
}

module.exports = {
  FREE_DAILY_LIMIT,
  PENDING_TTL_MINUTES,
  utcDay,
  initializeChatQuotaV2,
  reserveFreeChatV2,
  settleFreeChatV2,
};
