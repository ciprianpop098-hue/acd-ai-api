'use strict';

const crypto = require('node:crypto');

const FREE_DAILY_LIMIT = 5;

// Longer than the current analysis timeout.
// Expired reservations fail closed.
const RESERVATION_SECONDS = 180;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS analysis_daily_usage (
  uid TEXT NOT NULL,
  day DATE NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (uid, day),
  CONSTRAINT analysis_completed_valid
    CHECK (completed BETWEEN 0 AND 5)
);

CREATE TABLE IF NOT EXISTS analysis_reservations (
  id UUID PRIMARY KEY,
  uid TEXT NOT NULL,
  day DATE NOT NULL,
  request_id UUID,
  state TEXT NOT NULL DEFAULT 'pending',
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT analysis_state_valid
    CHECK (state IN (
      'pending', 'completed', 'failed', 'expired'
    ))
);

CREATE UNIQUE INDEX IF NOT EXISTS
analysis_request_id_unique
ON analysis_reservations(uid, day, request_id)
WHERE request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS
analysis_reservations_active_idx
ON analysis_reservations(uid, day, state, expires_at);

ALTER TABLE analysis_reservations
ADD COLUMN IF NOT EXISTS response_json JSONB;
`;

function verifiedUid(uid) {
  if (
    typeof uid !== 'string' ||
    uid.length < 1 ||
    uid.length > 128
  ) {
    throw new Error('Verified Firebase UID required');
  }

  return uid;
}

function verifiedRequestId(value) {
  if (value == null) return null;

  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  ) {
    throw new Error('Invalid request ID');
  }

  return value.toLowerCase();
}

async function transaction(pool, operation) {
  const db = await pool.connect();
  let began = false;

  try {
    await db.query('BEGIN');
    began = true;

    const result = await operation(db);

    await db.query('COMMIT');
    began = false;

    return result;
  } catch (error) {
    if (began) {
      try {
        await db.query('ROLLBACK');
      } catch (rollbackError) {
        error.rollbackError = rollbackError.message;
      }
    }

    throw error;
  } finally {
    db.release();
  }
}

async function initializeQuota(pool) {
  if (!pool || typeof pool.query !== 'function') {
    throw new Error('PostgreSQL pool required');
  }

  await pool.query(SCHEMA);
}

async function lockUsage(db, uid) {
  const currentDay = await db.query(`
    SELECT
      (NOW() AT TIME ZONE 'UTC')::date::text AS day
  `);

  const day = currentDay.rows[0].day;

  await db.query(
    `INSERT INTO analysis_daily_usage(uid, day)
     VALUES($1, $2::date)
     ON CONFLICT DO NOTHING`,
    [uid, day]
  );

  const usage = await db.query(
    `SELECT completed
     FROM analysis_daily_usage
     WHERE uid = $1
       AND day = $2::date
     FOR UPDATE`,
    [uid, day]
  );

  if (usage.rows.length !== 1) {
    throw new Error('Quota row unavailable');
  }

  return {
    day,
    completed: Number(usage.rows[0].completed),
  };
}

async function reserveFreeAnalysis(
  pool,
  firebaseUid,
  requestId = null
) {
  const uid = verifiedUid(firebaseUid);
  const idempotencyKey = verifiedRequestId(requestId);

  return transaction(pool, async (db) => {
    const { day, completed } = await lockUsage(db, uid);

    await db.query(
      `UPDATE analysis_reservations
       SET state = 'expired'
       WHERE uid = $1
         AND day = $2::date
         AND state = 'pending'
         AND expires_at <= NOW()`,
      [uid, day]
    );

    if (idempotencyKey) {
      const previous = await db.query(
        `SELECT id, state,
                expires_at > NOW() AS active
         FROM analysis_reservations
         WHERE uid = $1
           AND day = $2::date
           AND request_id = $3::uuid`,
        [uid, day, idempotencyKey]
      );

      if (previous.rows.length) {
        const previousRow = previous.rows[0];

        // Never start a duplicate AI request.
        return {
          allowed: false,
          duplicate: true,
          state: previousRow.state,
          reservationId: previousRow.id,
          day,
        };
      }
    }

    const active = await db.query(
      `SELECT COUNT(*)::integer AS count
       FROM analysis_reservations
       WHERE uid = $1
         AND day = $2::date
         AND state = 'pending'
         AND expires_at > NOW()`,
      [uid, day]
    );

    const pending = Number(active.rows[0].count);

    if (completed + pending >= FREE_DAILY_LIMIT) {
      return {
        allowed: false,
        duplicate: false,
        remaining: 0,
        day,
      };
    }

    const reservationId = crypto.randomUUID();

    await db.query(
      `INSERT INTO analysis_reservations
        (id, uid, day, request_id, expires_at)
       VALUES(
         $1::uuid,
         $2,
         $3::date,
         $4::uuid,
         NOW() + ($5 * INTERVAL '1 second')
       )`,
      [
        reservationId,
        uid,
        day,
        idempotencyKey,
        RESERVATION_SECONDS,
      ]
    );

    return {
      allowed: true,
      duplicate: false,
      reservationId,
      day,
      remaining:
        FREE_DAILY_LIMIT - completed - pending - 1,
    };
  });
}

async function finalizeFreeAnalysis(
  pool,
  firebaseUid,
  reservationId,
  succeeded
) {
  const uid = verifiedUid(firebaseUid);
  const id = verifiedRequestId(reservationId);

  if (!id) {
    throw new Error('Reservation ID required');
  }

  if (typeof succeeded !== 'boolean') {
    throw new Error('Success must be boolean');
  }

  return transaction(pool, async (db) => {
    const reservation = await db.query(
      `SELECT day
       FROM analysis_reservations
       WHERE id = $1::uuid
         AND uid = $2`,
      [id, uid]
    );

    if (reservation.rows.length !== 1) {
      throw new Error('Reservation not found');
    }

    const day = reservation.rows[0].day;

    // Same lock ordering as reserve:
    // daily usage first, reservation second.
    const usage = await db.query(
      `SELECT completed
       FROM analysis_daily_usage
       WHERE uid = $1
         AND day = $2::date
       FOR UPDATE`,
      [uid, day]
    );

    if (usage.rows.length !== 1) {
      throw new Error('Quota usage not found');
    }

    const locked = await db.query(
      `SELECT state,
              expires_at > NOW() AS active
       FROM analysis_reservations
       WHERE id = $1::uuid
         AND uid = $2
       FOR UPDATE`,
      [id, uid]
    );

    if (locked.rows.length !== 1) {
      throw new Error('Reservation disappeared');
    }

    const row = locked.rows[0];

    if (row.state !== 'pending') {
      return {
        counted: row.state === 'completed',
        state: row.state,
      };
    }

    if (!succeeded || !row.active) {
      const state =
        !row.active ? 'expired' : 'failed';

      await db.query(
        `UPDATE analysis_reservations
         SET state = $3
         WHERE id = $1::uuid AND uid = $2`,
        [id, uid, state]
      );

      return {
        counted: false,
        state,
      };
    }

    const increment = await db.query(
      `UPDATE analysis_daily_usage
       SET completed = completed + 1
       WHERE uid = $1
         AND day = $2::date
         AND completed < $3
       RETURNING completed`,
      [uid, day, FREE_DAILY_LIMIT]
    );

    if (increment.rows.length !== 1) {
      throw new Error('Quota finalization rejected');
    }

    await db.query(
      `UPDATE analysis_reservations
       SET state = 'completed'
       WHERE id = $1::uuid
         AND uid = $2`,
      [id, uid]
    );

    return {
      counted: true,
      state: 'completed',
      completed:
        Number(increment.rows[0].completed),
    };
  });
}


// ACD_ANALYSIS_RECOVERY_V3_4
// Only callable after Firebase UID verification
// in the HTTP layer.

async function completeFreeAnalysisWithResponse(
  pool,
  firebaseUid,
  reservationId,
  responsePayload
) {
  const uid = verifiedUid(firebaseUid);
  const id = verifiedRequestId(reservationId);

  if (!id) {
    throw new Error("Reservation ID required");
  }

  if (
    !responsePayload ||
    typeof responsePayload !== "object" ||
    Array.isArray(responsePayload) ||
    typeof responsePayload.verdict !== "string" ||
    !responsePayload.verdict.trim() ||
    typeof responsePayload.explanation !== "string" ||
    !responsePayload.explanation.trim()
  ) {
    throw new Error("Valid analysis response required");
  }

  const json = JSON.stringify(responsePayload);

  if (Buffer.byteLength(json, "utf8") > 262144) {
    throw new Error("Analysis response too large");
  }

  return transaction(pool, async (db) => {
    const found = await db.query(
      `SELECT day
       FROM analysis_reservations
       WHERE id = $1::uuid AND uid = $2`,
      [id, uid]
    );

    if (found.rows.length !== 1) {
      throw new Error("Reservation not found");
    }

    const day = found.rows[0].day;

    // Consistent lock order prevents deadlocks
    // with other quota transactions.
    const usage = await db.query(
      `SELECT completed
       FROM analysis_daily_usage
       WHERE uid = $1 AND day = $2::date
       FOR UPDATE`,
      [uid, day]
    );

    if (usage.rows.length !== 1) {
      throw new Error("Quota usage not found");
    }

    const reservation = await db.query(
      `SELECT state, expires_at > NOW() AS active,
              response_json
       FROM analysis_reservations
       WHERE id = $1::uuid AND uid = $2
       FOR UPDATE`,
      [id, uid]
    );

    if (reservation.rows.length !== 1) {
      throw new Error("Reservation disappeared");
    }

    const row = reservation.rows[0];

    if (row.state === "completed") {
      return {
        counted: row.response_json != null,
        alreadyCompleted: true,
      };
    }

    if (row.state !== "pending" || !row.active) {
      return {
        counted: false,
        state: row.state,
      };
    }

    const increment = await db.query(
      `UPDATE analysis_daily_usage
       SET completed = completed + 1
       WHERE uid = $1
         AND day = $2::date
         AND completed < $3
       RETURNING completed`,
      [uid, day, FREE_DAILY_LIMIT]
    );

    if (increment.rows.length !== 1) {
      throw new Error("Quota completion rejected");
    }

    const saved = await db.query(
      `UPDATE analysis_reservations
       SET state = 'completed',
           response_json = $3::jsonb
       WHERE id = $1::uuid
         AND uid = $2
         AND state = 'pending'
       RETURNING id`,
      [id, uid, json]
    );

    if (saved.rows.length !== 1) {
      throw new Error("Result persistence failed");
    }

    return {
      counted: true,
      alreadyCompleted: false,
      completed: Number(increment.rows[0].completed),
    };
  });
}

async function getCompletedAnalysis(
  pool,
  firebaseUid,
  requestId
) {
  const uid = verifiedUid(firebaseUid);
  const id = verifiedRequestId(requestId);

  if (!id) {
    throw new Error("Request ID required");
  }

  const result = await pool.query(
    `SELECT state, response_json
     FROM analysis_reservations
     WHERE uid = $1
       AND request_id = $2::uuid
     ORDER BY created_at DESC
     LIMIT 1`,
    [uid, id]
  );

  if (!result.rows.length) {
    return { state: "not_found", response: null };
  }

  const row = result.rows[0];

  if (
    row.state === "completed" &&
    row.response_json &&
    typeof row.response_json === "object"
  ) {
    return {
      state: "completed",
      response: row.response_json,
    };
  }

  return {
    state: row.state,
    response: null,
  };
}

module.exports = {
  FREE_DAILY_LIMIT,
  RESERVATION_SECONDS,
  initializeQuota,
  reserveFreeAnalysis,
  finalizeFreeAnalysis,
  completeFreeAnalysisWithResponse,
  getCompletedAnalysis,
};
