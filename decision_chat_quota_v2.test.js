"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  FREE_DAILY_LIMIT,
  PENDING_TTL_MINUTES,
  utcDay,
  reserveFreeChatV2,
  settleFreeChatV2,
} = require("./decision_chat_quota_v2");

function mockPool(used = 0, affected = 1) {
  const queries = [];

  const client = {
    query: async (sql, params) => {
      queries.push({ sql, params });

      if (sql.includes("COUNT(*)")) {
        return {
          rowCount: 1,
          rows: [{ used }],
        };
      }

      if (sql.includes("RETURNING id")) {
        return {
          rowCount: affected,
          rows: affected ? [{ id: "test" }] : [],
        };
      }

      return { rowCount: 1, rows: [] };
    },
    release: () => {},
  };

  return {
    queries,
    connect: async () => client,
    query: client.query,
  };
}

test("FREE daily quota is 15", () => {
  assert.equal(FREE_DAILY_LIMIT, 15);
});

test("Pending expiration is defined", () => {
  assert.equal(PENDING_TTL_MINUTES, 15);
});

test("UTC day is stable", () => {
  assert.equal(
    utcDay(new Date("2026-10-27T23:59:00Z")),
    "2026-10-27"
  );
});

test("Reject unauthenticated users", async () => {
  await assert.rejects(
    reserveFreeChatV2(mockPool(), ""),
    /Invalid authenticated UID/
  );
});

test("Allow FREE reservation when under limit", async () => {
  const pool = mockPool(5);

  const result = await reserveFreeChatV2(
    pool,
    "user-1",
    "2026-10-27"
  );

  assert.equal(result.allowed, true);
  assert.equal(result.remaining, 9);
  assert.match(result.reservationId, /^[0-9a-f-]{36}$/);

  assert.ok(
    pool.queries.some(
      q => q.sql.includes("pg_advisory_xact_lock")
    )
  );
});

test("Block FREE at daily quota", async () => {
  const result = await reserveFreeChatV2(
    mockPool(15),
    "user-1",
    "2026-10-27"
  );

  assert.equal(result.allowed, false);
  assert.equal(result.remaining, 0);
});

test("Prevent another UID from settling reservation", async () => {
  const pool = mockPool(0, 0);

  const result = await settleFreeChatV2(
    pool,
    "other-user",
    "11111111-1111-4111-8111-111111111111",
    true
  );

  assert.equal(result.transitioned, false);
});

test("Settlement only updates pending reservations", async () => {
  const pool = mockPool();

  const result = await settleFreeChatV2(
    pool,
    "user-1",
    "11111111-1111-4111-8111-111111111111",
    true
  );

  assert.equal(result.transitioned, true);

  const update = pool.queries.find(
    q => q.sql.includes("UPDATE acd_chat_reservations_v2")
  );

  assert.ok(update);
  assert.match(update.sql, /state = 'pending'/);
  assert.equal(update.params[1], "user-1");
  assert.equal(update.params[2], "completed");
});
