'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  reserveFreeAnalysis,
  finalizeFreeAnalysis,
  completeFreeAnalysisWithResponse,
  getCompletedAnalysis,
} = require('./analysis_quota');

const DAY = '2026-10-27';

const ANALYSIS = {
  verdict: 'Option A',
  explanation: 'Option A offers stronger potential.',
  confidence: '88',
  language: 'en',
};

function fakePostgres() {
  let counts = new Map();
  let rows = new Map();
  let queue = Promise.resolve();
  let injectWriteFailure = false;

  function copyRows(map) {
    return new Map(
      [...map].map(([k, v]) => [k, structuredClone(v)])
    );
  }

  async function execute(sql, a = []) {
    const q = sql.replace(/\s+/g, ' ').trim();

    if (q.includes("AT TIME ZONE 'UTC'")) {
      return { rows: [{ day: DAY }] };
    }

    if (q.includes('INSERT INTO analysis_daily_usage')) {
      const key = `${a[0]}:${a[1]}`;
      if (!counts.has(key)) counts.set(key, 0);
      return { rows: [] };
    }

    if (
      q.includes('SELECT completed') &&
      q.includes('FROM analysis_daily_usage')
    ) {
      const key = `${a[0]}:${a[1]}`;
      return {
        rows: counts.has(key)
          ? [{ completed: counts.get(key) }]
          : [],
      };
    }

    if (
      q.includes('SET state = \'expired\'') &&
      q.includes('analysis_reservations')
    ) {
      for (const r of rows.values()) {
        if (
          r.uid === a[0] &&
          r.day === a[1] &&
          r.state === 'pending' &&
          !r.active
        ) {
          r.state = 'expired';
        }
      }
      return { rows: [] };
    }

    if (
      q.includes('SELECT id, state') &&
      q.includes('request_id')
    ) {
      const r = [...rows.values()].find(
        x =>
          x.uid === a[0] &&
          x.day === a[1] &&
          x.requestId === a[2]
      );
      return {
        rows: r
          ? [{
              id: r.id,
              state: r.state,
              active: r.active,
            }]
          : [],
      };
    }

    if (q.includes('COUNT(*)::integer')) {
      const count = [...rows.values()].filter(
        r =>
          r.uid === a[0] &&
          r.day === a[1] &&
          r.state === 'pending' &&
          r.active
      ).length;
      return { rows: [{ count }] };
    }

    if (q.includes('INSERT INTO analysis_reservations')) {
      rows.set(a[0], {
        id: a[0],
        uid: a[1],
        day: a[2],
        requestId: a[3],
        state: 'pending',
        active: true,
        response: null,
        createdAt: Date.now(),
      });
      return { rows: [] };
    }

    if (
      q.includes('SELECT day') &&
      q.includes('FROM analysis_reservations')
    ) {
      const r = rows.get(a[0]);
      return {
        rows: r && r.uid === a[1] ? [{ day: r.day }] : [],
      };
    }

    if (
      q.includes('SELECT state') &&
      q.includes('FOR UPDATE') &&
      q.includes('analysis_reservations')
    ) {
      const r = rows.get(a[0]);
      return {
        rows: r && r.uid === a[1]
          ? [{
              state: r.state,
              active: r.active,
              response_json: r.response,
            }]
          : [],
      };
    }

    if (
      q.includes('UPDATE analysis_daily_usage') &&
      q.includes('RETURNING completed')
    ) {
      const key = `${a[0]}:${a[1]}`;
      const old = counts.get(key);

      if (old === undefined || old >= a[2]) {
        return { rows: [] };
      }

      counts.set(key, old + 1);
      return { rows: [{ completed: old + 1 }] };
    }

    if (
      q.includes('UPDATE analysis_reservations') &&
      q.includes('response_json = $3::jsonb')
    ) {
      if (injectWriteFailure) {
        injectWriteFailure = false;
        throw Error('Simulated DB write failure');
      }

      const r = rows.get(a[0]);

      if (
        !r ||
        r.uid !== a[1] ||
        r.state !== 'pending'
      ) {
        return { rows: [] };
      }

      r.state = 'completed';
      r.response = JSON.parse(a[2]);
      return { rows: [{ id: r.id }] };
    }

    if (
      q.includes('UPDATE analysis_reservations') &&
      q.includes('SET state = $3')
    ) {
      const r = rows.get(a[0]);
      r.state = a[2];
      return { rows: [] };
    }

    if (
      q.includes('UPDATE analysis_reservations') &&
      q.includes("SET state = 'completed'")
    ) {
      const r = rows.get(a[0]);
      r.state = 'completed';
      return { rows: [] };
    }

    if (
      q.includes('SELECT state, response_json') &&
      q.includes('ORDER BY created_at DESC')
    ) {
      const r = [...rows.values()]
        .filter(x =>
          x.uid === a[0] &&
          x.requestId === a[1]
        )
        .sort((x, y) => y.createdAt - x.createdAt)[0];

      return {
        rows: r
          ? [{
              state: r.state,
              response_json: r.response,
            }]
          : [],
      };
    }

    throw Error('Unknown mocked SQL: ' + q);
  }

  return {
    counts,
    rows,

    injectFailure() {
      injectWriteFailure = true;
    },

    async connect() {
      const previous = queue;
      let unlock;

      queue = new Promise(resolve => {
        unlock = resolve;
      });

      await previous;

      let snapshot = null;

      return {
        release: unlock,

        async query(sql, args = []) {
          const command = sql.trim();

          if (command === 'BEGIN') {
            snapshot = {
              counts: new Map(counts),
              rows: copyRows(rows),
            };
            return { rows: [] };
          }

          if (command === 'COMMIT') {
            snapshot = null;
            return { rows: [] };
          }

          if (command === 'ROLLBACK') {
            if (snapshot) {
              counts = snapshot.counts;
              rows = snapshot.rows;
            }
            snapshot = null;
            return { rows: [] };
          }

          return execute(sql, args);
        },
      };
    },

    query: execute,

    completed(uid) {
      return counts.get(`${uid}:${DAY}`) ?? 0;
    },

    expire(id) {
      rows.get(id).active = false;
    },
  };
}

test('stores and recovers a completed analysis', async () => {
  const db = fakePostgres();
  const id = crypto.randomUUID();

  const reservation = await reserveFreeAnalysis(
    db, 'owner', id
  );

  assert.equal(reservation.allowed, true);

  const completion = await completeFreeAnalysisWithResponse(
    db, 'owner', reservation.reservationId, ANALYSIS
  );

  assert.equal(completion.counted, true);

  const result = await getCompletedAnalysis(
    db, 'owner', id
  );

  assert.equal(result.state, 'completed');
  assert.deepEqual(result.response, ANALYSIS);
  assert.equal(db.completed('owner'), 1);
});

test('another user cannot recover the analysis', async () => {
  const db = fakePostgres();
  const id = crypto.randomUUID();

  const r = await reserveFreeAnalysis(db, 'owner', id);

  await completeFreeAnalysisWithResponse(
    db, 'owner', r.reservationId, ANALYSIS
  );

  const stolen = await getCompletedAnalysis(
    db, 'attacker', id
  );

  assert.equal(stolen.state, 'not_found');
  assert.equal(stolen.response, null);
});

test('five recovery reads do not charge again', async () => {
  const db = fakePostgres();
  const id = crypto.randomUUID();

  const r = await reserveFreeAnalysis(db, 'owner', id);

  await completeFreeAnalysisWithResponse(
    db, 'owner', r.reservationId, ANALYSIS
  );

  for (let i = 0; i < 5; i++) {
    const result = await getCompletedAnalysis(
      db, 'owner', id
    );
    assert.equal(result.state, 'completed');
  }

  assert.equal(db.completed('owner'), 1);
});

test('repeated completion charges only once', async () => {
  const db = fakePostgres();
  const id = crypto.randomUUID();

  const r = await reserveFreeAnalysis(db, 'owner', id);

  const first = await completeFreeAnalysisWithResponse(
    db, 'owner', r.reservationId, ANALYSIS
  );

  const second = await completeFreeAnalysisWithResponse(
    db, 'owner', r.reservationId, ANALYSIS
  );

  assert.equal(first.counted, true);
  assert.equal(second.alreadyCompleted, true);
  assert.equal(db.completed('owner'), 1);
});

test('failed response persistence rolls back quota', async () => {
  const db = fakePostgres();
  const id = crypto.randomUUID();

  const r = await reserveFreeAnalysis(db, 'owner', id);

  db.injectFailure();

  await assert.rejects(
    completeFreeAnalysisWithResponse(
      db, 'owner', r.reservationId, ANALYSIS
    ),
    /Simulated DB write failure/
  );

  assert.equal(db.completed('owner'), 0);

  const result = await getCompletedAnalysis(
    db, 'owner', id
  );

  assert.equal(result.state, 'pending');
});

test('expired reservation cannot charge', async () => {
  const db = fakePostgres();
  const id = crypto.randomUUID();

  const r = await reserveFreeAnalysis(db, 'owner', id);
  db.expire(r.reservationId);

  const result = await completeFreeAnalysisWithResponse(
    db, 'owner', r.reservationId, ANALYSIS
  );

  assert.equal(result.counted, false);
  assert.equal(db.completed('owner'), 0);
});

test('failed analysis cannot be recovered as success', async () => {
  const db = fakePostgres();
  const id = crypto.randomUUID();

  const r = await reserveFreeAnalysis(db, 'owner', id);

  await finalizeFreeAnalysis(
    db, 'owner', r.reservationId, false
  );

  const result = await getCompletedAnalysis(
    db, 'owner', id
  );

  assert.equal(result.state, 'failed');
  assert.equal(result.response, null);
});

test('invalid result cannot be charged', async () => {
  const db = fakePostgres();
  const r = await reserveFreeAnalysis(
    db, 'owner', crypto.randomUUID()
  );

  await assert.rejects(
    completeFreeAnalysisWithResponse(
      db, 'owner', r.reservationId,
      { verdict: '', explanation: '' }
    ),
    /Valid analysis response/
  );

  assert.equal(db.completed('owner'), 0);
});

test('another UID cannot finalize reservation', async () => {
  const db = fakePostgres();
  const r = await reserveFreeAnalysis(
    db, 'owner', crypto.randomUUID()
  );

  await assert.rejects(
    completeFreeAnalysisWithResponse(
      db, 'attacker', r.reservationId, ANALYSIS
    ),
    /Reservation not found/
  );

  assert.equal(db.completed('owner'), 0);
});
