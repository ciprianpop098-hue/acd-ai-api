"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  validUid,
  validId,
  messageFingerprint,
  findRecoveredChat,
} = require("./decision_chat_recovery");

const decisionId =
  "11111111-1111-4111-8111-111111111111";

const requestId =
  "22222222-2222-4222-8222-222222222222";

const fingerprint = messageFingerprint(
  decisionId,
  "What should I do next?"
);

test("Firebase UID validation", () => {
  assert.equal(validUid("user-1"), true);
  assert.equal(validUid(""), false);
});

test("UUID validation", () => {
  assert.equal(validId(requestId), true);
  assert.equal(validId("../other-user"), false);
});

test("Same message produces same fingerprint", () => {
  assert.equal(
    messageFingerprint(
      decisionId,
      "What should I do next?"
    ),
    fingerprint
  );
});

test("Different messages cannot reuse same identity", () => {
  assert.notEqual(
    messageFingerprint(decisionId, "Different question"),
    fingerprint
  );
});

test("Unknown request is not recovered", async () => {
  const pool = {
    query: async () => ({
      rowCount: 0,
      rows: [],
    }),
  };

  const result = await findRecoveredChat(
    pool,
    "user-1",
    requestId,
    decisionId,
    fingerprint
  );

  assert.equal(result.state, "not_found");
});

test("Completed response is recovered for owner", async () => {
  const saved = {
    success: true,
    reply: "Compare the risks first.",
  };

  const pool = {
    query: async (sql, params) => {
      assert.match(sql, /WHERE uid = \$1/);
      assert.equal(params[0], "user-1");

      return {
        rowCount: 1,
        rows: [{
          decision_id: decisionId,
          request_hash: fingerprint,
          response: saved,
        }],
      };
    },
  };

  const result = await findRecoveredChat(
    pool,
    "user-1",
    requestId,
    decisionId,
    fingerprint
  );

  assert.equal(result.state, "completed");
  assert.deepEqual(result.response, saved);
});

test("Request ID reuse with different content is rejected", async () => {
  const pool = {
    query: async () => ({
      rowCount: 1,
      rows: [{
        decision_id: decisionId,
        request_hash: "a".repeat(64),
        response: { reply: "Old reply" },
      }],
    }),
  };

  const result = await findRecoveredChat(
    pool,
    "user-1",
    requestId,
    decisionId,
    fingerprint
  );

  assert.equal(result.state, "conflict");
});

test("Pending response is not presented as completed", async () => {
  const pool = {
    query: async () => ({
      rowCount: 1,
      rows: [{
        decision_id: decisionId,
        request_hash: fingerprint,
        response: null,
      }],
    }),
  };

  const result = await findRecoveredChat(
    pool,
    "user-1",
    requestId,
    decisionId,
    fingerprint
  );

  assert.equal(result.state, "pending");
});

test("Malformed recovery identity is rejected", async () => {
  await assert.rejects(
    findRecoveredChat(
      {},
      "user-1",
      "bad-request-id",
      decisionId,
      fingerprint
    ),
    /Invalid recovery identity/
  );
});
