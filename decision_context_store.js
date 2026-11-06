"use strict";

const crypto = require("node:crypto");

function validUid(uid) {
  return typeof uid === "string" &&
    uid.length > 0 &&
    uid.length <= 128;
}

function validDecisionId(id) {
  return typeof id === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

async function initializeDecisionStore(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS acd_decision_contexts (
      id UUID PRIMARY KEY,
      uid TEXT NOT NULL,
      option_a TEXT NOT NULL,
      option_b TEXT NOT NULL,
      analysis JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT acd_decision_uid_valid
        CHECK (length(uid) BETWEEN 1 AND 128)
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS acd_decision_contexts_owner_idx
    ON acd_decision_contexts(uid, created_at DESC)
  `);
}

async function storeDecision(
  pool,
  uid,
  optionA,
  optionB,
  analysis
) {
  if (!validUid(uid)) throw Error("Invalid authenticated UID");

  if (
    typeof optionA !== "string" ||
    typeof optionB !== "string" ||
    !optionA.trim() ||
    !optionB.trim() ||
    optionA.length > 500 ||
    optionB.length > 500 ||
    !analysis ||
    typeof analysis !== "object" ||
    Array.isArray(analysis)
  ) {
    throw Error("Invalid decision context");
  }

  const serialized = JSON.stringify(analysis);

  if (serialized.length > 30000) {
    throw Error("Decision context too large");
  }

  const id = crypto.randomUUID();

  await pool.query(`
    INSERT INTO acd_decision_contexts
      (id, uid, option_a, option_b, analysis)
    VALUES ($1, $2, $3, $4, $5::jsonb)
  `, [
    id,
    uid,
    optionA.trim(),
    optionB.trim(),
    serialized,
  ]);

  return id;
}

async function getOwnedDecision(pool, uid, decisionId) {
  if (!validUid(uid) || !validDecisionId(decisionId)) {
    return null;
  }

  const result = await pool.query(`
    SELECT id, option_a, option_b, analysis
    FROM acd_decision_contexts
    WHERE id = $1::uuid AND uid = $2
    LIMIT 1
  `, [decisionId, uid]);

  if (result.rowCount !== 1) return null;

  const row = result.rows[0];

  return {
    decisionId: String(row.id),
    optionA: row.option_a,
    optionB: row.option_b,
    analysis: row.analysis,
  };
}

module.exports = {
  initializeDecisionStore,
  storeDecision,
  getOwnedDecision,
};
