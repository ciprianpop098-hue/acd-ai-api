"use strict";

const crypto = require("node:crypto");

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validUid(uid) {
  return typeof uid === "string" &&
    uid.trim().length > 0 &&
    uid.length <= 128;
}

function validId(id) {
  return typeof id === "string" &&
    UUID_RE.test(id);
}

function messageFingerprint(decisionId, message) {
  if (!validId(decisionId)) {
    throw new Error("Invalid secure decision ID");
  }

  if (
    typeof message !== "string" ||
    !message.trim() ||
    message.length > 2000
  ) {
    throw new Error("Invalid chat message");
  }

  return crypto.createHash("sha256")
    .update(JSON.stringify([
      decisionId.toLowerCase(),
      message.trim(),
    ]))
    .digest("hex");
}

async function initializeChatRecovery(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS acd_chat_recovery_v1 (
      uid TEXT NOT NULL,
      request_id UUID NOT NULL,
      decision_id UUID NOT NULL,
      request_hash TEXT NOT NULL,
      reservation_id UUID,
      response JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      PRIMARY KEY (uid, request_id),
      CONSTRAINT acd_chat_recovery_uid_valid
        CHECK (length(uid) BETWEEN 1 AND 128),
      CONSTRAINT acd_chat_recovery_hash_valid
        CHECK (length(request_hash) = 64)
    )
  `);
  await pool.query(`
    ALTER TABLE acd_chat_recovery_v1
    ADD COLUMN IF NOT EXISTS reservation_id UUID
  `);
}

async function findRecoveredChat(
  pool,
  uid,
  requestId,
  decisionId,
  fingerprint
) {
  if (
    !validUid(uid) ||
    !validId(requestId) ||
    !validId(decisionId) ||
    typeof fingerprint !== "string" ||
    !/^[0-9a-f]{64}$/.test(fingerprint)
  ) {
    throw new Error("Invalid recovery identity");
  }

  const result = await pool.query(`
    SELECT request_hash, decision_id, response
    FROM acd_chat_recovery_v1
    WHERE uid = $1
      AND request_id = $2::uuid
    LIMIT 1
  `, [uid, requestId]);

  if (result.rowCount === 0) {
    return { state: "not_found" };
  }

  const row = result.rows[0];

  if (
    String(row.decision_id).toLowerCase() !==
      decisionId.toLowerCase() ||
    row.request_hash !== fingerprint
  ) {
    return { state: "conflict" };
  }

  if (row.response == null) {
    return { state: "pending" };
  }

  return {
    state: "completed",
    response: row.response,
  };
}


const CHAT_LIMIT = 15;

// Begin a recoverable FREE Chat request.
//
// All quota checks and inserts run under the same
// PostgreSQL transaction and advisory lock.
async function beginRecoverableChat(
  pool,
  uid,
  requestId,
  decisionId,
  fingerprint
) {
  if (
    !validUid(uid) ||
    !validId(requestId) ||
    !validId(decisionId) ||
    !/^[0-9a-f]{64}$/.test(fingerprint)
  ) {
    throw new Error("Invalid chat recovery identity");
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(
      `SELECT pg_advisory_xact_lock(
        hashtext($1::text),
        hashtext($2::text)
      )`,
      [uid, "chat-recovery"]
    );

    const existing = await client.query(
      `SELECT decision_id, request_hash, response, created_at
       FROM acd_chat_recovery_v1
       WHERE uid = $1 AND request_id = $2::uuid
       FOR UPDATE`,
      [uid, requestId]
    );

    if (existing.rowCount > 0) {
      const row = existing.rows[0];

      await client.query("COMMIT");

      if (
        String(row.decision_id).toLowerCase() !==
          decisionId.toLowerCase() ||
        row.request_hash !== fingerprint
      ) {
        return { state: "conflict" };
      }

      if (row.response != null) {
        return {
          state: "completed",
          response: row.response,
        };
      }

      const created = new Date(row.created_at).getTime();

      if (
        Number.isFinite(created) &&
        Date.now() - created >= 15 * 60 * 1000
      ) {
        return { state: "expired" };
      }

      return { state: "pending" };
    }

    const day = new Date().toISOString().slice(0, 10);

    const usage = await client.query(
      `SELECT COUNT(*)::integer AS used
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
         )`,
      [uid, day]
    );

    const used = Number(usage.rows[0].used);

    if (used >= CHAT_LIMIT) {
      await client.query("COMMIT");

      return {
        state: "limit",
        limit: CHAT_LIMIT,
        remaining: 0,
      };
    }

    const crypto = require("node:crypto");
    const reservationId = crypto.randomUUID();

    await client.query(
      `INSERT INTO acd_chat_reservations_v2
       (id, uid, day, state)
       VALUES ($1::uuid, $2, $3::date, 'pending')`,
      [reservationId, uid, day]
    );

    await client.query(
      `INSERT INTO acd_chat_recovery_v1
       (uid, request_id, decision_id, request_hash, reservation_id)
       VALUES ($1, $2::uuid, $3::uuid, $4, $5::uuid)`,
      [uid, requestId, decisionId, fingerprint, reservationId]
    );

    await client.query("COMMIT");

    return {
      state: "reserved",
      reservationId,
      remaining: CHAT_LIMIT - used - 1,
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

// Store the successful response and finalize FREE quota
// atomically. Retrying cannot count the same request twice.
async function completeRecoverableChat(
  pool,
  uid,
  requestId,
  reservationId,
  response
) {
  if (
    !validUid(uid) ||
    !validId(requestId) ||
    !validId(reservationId) ||
    !response ||
    typeof response.reply !== "string" ||
    !response.reply.trim()
  ) {
    throw new Error("Invalid Chat completion");
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const reservation = await client.query(
      `UPDATE acd_chat_reservations_v2
       SET state = 'completed',
           finalized_at = NOW()
       WHERE id = $1::uuid
         AND uid = $2
         AND state = 'pending'
         AND created_at >
           NOW() - INTERVAL '15 minutes'
       RETURNING id`,
      [reservationId, uid]
    );

    if (reservation.rowCount !== 1) {
      await client.query("ROLLBACK");

      return { completed: false };
    }

    const saved = await client.query(
      `UPDATE acd_chat_recovery_v1
       SET response = $3::jsonb,
           completed_at = NOW()
       WHERE uid = $1
         AND request_id = $2::uuid
         AND reservation_id = $4::uuid
         AND response IS NULL
       RETURNING request_id`,
      [
        uid,
        requestId,
        JSON.stringify(response),
        reservationId,
      ]
    );

    if (saved.rowCount !== 1) {
      await client.query("ROLLBACK");

      return { completed: false };
    }

    await client.query("COMMIT");

    return { completed: true };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}

    throw error;
  } finally {
    client.release();
  }
}

// Release a failed request. The recovery identity is also
// removed, allowing the same requestId to be retried.
async function failRecoverableChat(
  pool,
  uid,
  requestId,
  reservationId
) {
  if (
    !validUid(uid) ||
    !validId(requestId) ||
    !validId(reservationId)
  ) {
    throw new Error("Invalid failed Chat identity");
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const released = await client.query(
      `UPDATE acd_chat_reservations_v2
       SET state = 'released',
           finalized_at = NOW()
       WHERE id = $1::uuid
         AND uid = $2
         AND state = 'pending'
       RETURNING id`,
      [reservationId, uid]
    );

    if (released.rowCount !== 1) {
      await client.query("ROLLBACK");
      return { released: false };
    }

    await client.query(
      `DELETE FROM acd_chat_recovery_v1
       WHERE uid = $1
         AND request_id = $2::uuid
         AND reservation_id = $3::uuid
         AND response IS NULL`,
      [uid, requestId, reservationId]
    );

    await client.query("COMMIT");

    return { released: true };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}

    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  beginRecoverableChat,
  completeRecoverableChat,
  failRecoverableChat,
  validUid,
  validId,
  messageFingerprint,
  initializeChatRecovery,
  findRecoveredChat,
};
