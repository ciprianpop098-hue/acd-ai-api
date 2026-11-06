"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  storeDecision,
  getOwnedDecision,
} = require("./decision_context_store");

test("reject invalid authenticated identity", async () => {
  await assert.rejects(
    storeDecision({}, "", "A", "B", { verdict: "A" }),
    /Invalid authenticated UID/
  );
});

test("reject malformed decision ID", async () => {
  const result = await getOwnedDecision(
    {},
    "user-1",
    "../../another-user"
  );
  assert.equal(result, null);
});

test("store new decision with verified user identity", async () => {
  let insertCalled = false;

  const pool = {
    query: async (sql, params) => {
      insertCalled = true;
      assert.match(sql, /INSERT INTO acd_decision_contexts/);
      assert.equal(params[1], "user-1");
      return { rowCount: 1 };
    },
  };

  const id = await storeDecision(
    pool,
    "user-1",
    "Option A",
    "Option B",
    { verdict: "A" }
  );

  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.equal(insertCalled, true);
});

test("owner lookup uses authenticated UID", async () => {
  const id = "11111111-1111-4111-8111-111111111111";

  const pool = {
    query: async (sql, params) => {
      assert.match(sql, /AND uid = \$2/);
      assert.deepEqual(params, [id, "owner-1"]);
      return {
        rowCount: 1,
        rows: [{
          id,
          option_a: "A",
          option_b: "B",
          analysis: { verdict: "A" },
        }],
      };
    },
  };

  const result = await getOwnedDecision(
    pool, "owner-1", id
  );

  assert.equal(result.decisionId, id);
});

test("another user cannot retrieve a decision", async () => {
  const pool = {
    query: async () => ({
      rowCount: 0,
      rows: [],
    }),
  };

  const result = await getOwnedDecision(
    pool,
    "different-user",
    "11111111-1111-4111-8111-111111111111"
  );

  assert.equal(result, null);
});
