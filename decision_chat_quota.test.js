"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  FREE_CHAT_DAILY_LIMIT,
  utcDay,
  reserveFreeChat,
  releaseFreeChat,
} = require("./decision_chat_quota");

test("FREE limit is 15", () => {
  assert.equal(FREE_CHAT_DAILY_LIMIT, 15);
});

test("UTC reset date", () => {
  assert.equal(
    utcDay(new Date("2026-10-27T23:59:00Z")),
    "2026-10-27"
  );
});

test("Reject missing authenticated UID", async () => {
  await assert.rejects(
    reserveFreeChat(
      { query: async () => { throw Error("unexpected DB"); } },
      ""
    ),
    /Authenticated UID required/
  );
});

test("Allow and report remaining messages", async () => {
  const pool = {
    query: async () => ({
      rowCount: 1,
      rows: [{ used: 5 }],
    }),
  };

  const result = await reserveFreeChat(
    pool, "test-user", "2026-10-27"
  );

  assert.equal(result.allowed, true);
  assert.equal(result.remaining, 10);
});

test("Block FREE when daily quota is exhausted", async () => {
  const pool = {
    query: async () => ({
      rowCount: 0,
      rows: [],
    }),
  };

  const result = await reserveFreeChat(
    pool, "test-user", "2026-10-27"
  );

  assert.equal(result.allowed, false);
  assert.equal(result.remaining, 0);
});

test("Release unsuccessful reservation", async () => {
  const calls = [];
  const pool = {
    query: async (...args) => {
      calls.push(args);
      return { rowCount: 1 };
    },
  };

  await releaseFreeChat(
    pool, "test-user", "2026-10-27"
  );

  assert.equal(calls.length, 1);
});
