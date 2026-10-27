'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const quota = require('./analysis_quota');

function fakeDatabase() {
  const usage = new Map();
  const reservations = new Map();

  let lock = Promise.resolve();

  function dbClient(releaseLock) {
    return {
      release() {
        releaseLock();
      },

      async query(sql, args = []) {
        const q = sql.replace(/\s+/g, ' ').trim();

        if (
          q === 'BEGIN' ||
          q === 'COMMIT' ||
          q === 'ROLLBACK'
        ) {
          return { rows: [] };
        }

        if (q.includes('AS day') && q.includes('UTC')) {
          return {
            rows: [{ day: '2026-10-27' }],
          };
        }

        if (q.includes('INSERT INTO analysis_daily_usage')) {
          const key = `${args[0]}:${args[1]}`;

          if (!usage.has(key)) usage.set(key, 0);

          return { rows: [] };
        }

        if (
          q.includes('SELECT completed') &&
          q.includes('FOR UPDATE')
        ) {
          const key = `${args[0]}:${args[1]}`;

          return usage.has(key)
            ? { rows: [{ completed: usage.get(key) }] }
            : { rows: [] };
        }

        if (
          q.includes('UPDATE analysis_reservations') &&
          q.includes("SET state = 'expired'")
        ) {
          return { rows: [] };
        }

        if (
          q.includes('SELECT id, state') &&
          q.includes('request_id')
        ) {
          const row = [...reservations.values()].find(
            r =>
              r.uid === args[0] &&
              r.day === args[1] &&
              r.requestId === args[2]
          );

          return {
            rows: row
              ? [{
                  id: row.id,
                  state: row.state,
                  active: row.active,
                }]
              : [],
          };
        }

        if (q.includes('COUNT(*)::integer')) {
          const count = [...reservations.values()]
            .filter(
              r =>
                r.uid === args[0] &&
                r.day === args[1] &&
                r.state === 'pending' &&
                r.active
            ).length;

          return { rows: [{ count }] };
        }

        if (q.includes('INSERT INTO analysis_reservations')) {
          reservations.set(args[0], {
            id: args[0],
            uid: args[1],
            day: args[2],
            requestId: args[3],
            state: 'pending',
            active: true,
          });

          return { rows: [] };
        }

        if (
          q.includes('SELECT day') &&
          q.includes('FROM analysis_reservations')
        ) {
          const row = reservations.get(args[0]);

          return {
            rows:
              row && row.uid === args[1]
                ? [{ day: row.day }]
                : [],
          };
        }

        if (
          q.includes('SELECT state') &&
          q.includes('AS active')
        ) {
          const row = reservations.get(args[0]);

          return {
            rows:
              row && row.uid === args[1]
                ? [{
                    state: row.state,
                    active: row.active,
                  }]
                : [],
          };
        }

        if (
          q.includes('UPDATE analysis_daily_usage') &&
          q.includes('RETURNING completed')
        ) {
          const key = `${args[0]}:${args[1]}`;
          const current = usage.get(key);

          if (current == null || current >= args[2]) {
            return { rows: [] };
          }

          usage.set(key, current + 1);

          return {
            rows: [{ completed: current + 1 }],
          };
        }

        if (
          q.includes('UPDATE analysis_reservations') &&
          q.includes('SET state = $3')
        ) {
          reservations.get(args[0]).state = args[2];

          return { rows: [] };
        }

        if (
          q.includes('UPDATE analysis_reservations') &&
          q.includes("SET state = 'completed'")
        ) {
          reservations.get(args[0]).state = 'completed';

          return { rows: [] };
        }

        throw new Error('Unexpected SQL in mock: ' + q);
      },
    };
  }

  return {
    usage,
    reservations,

    async connect() {
      const previous = lock;
      let unlock;

      lock = new Promise(resolve => {
        unlock = resolve;
      });

      await previous;

      return dbClient(unlock);
    },
  };
}

test('limit is exactly 5', () => {
  assert.equal(quota.FREE_DAILY_LIMIT, 5);
});

test('reservation TTL exceeds analysis timeout', () => {
  assert.ok(quota.RESERVATION_SECONDS > 25);
});

test('five successful analyses are counted', async () => {
  const db = fakeDatabase();

  for (let i = 0; i < 5; i++) {
    const reservation =
      await quota.reserveFreeAnalysis(db, 'user-1');

    assert.equal(reservation.allowed, true);

    const result = await quota.finalizeFreeAnalysis(
      db,
      'user-1',
      reservation.reservationId,
      true
    );

    assert.equal(result.counted, true);
    assert.equal(result.completed, i + 1);
  }

  const sixth =
    await quota.reserveFreeAnalysis(db, 'user-1');

  assert.equal(sixth.allowed, false);
});

test('failed analysis does not consume quota', async () => {
  const db = fakeDatabase();

  const reservation =
    await quota.reserveFreeAnalysis(db, 'user-2');

  const failed = await quota.finalizeFreeAnalysis(
    db,
    'user-2',
    reservation.reservationId,
    false
  );

  assert.equal(failed.counted, false);

  const replacement =
    await quota.reserveFreeAnalysis(db, 'user-2');

  assert.equal(replacement.allowed, true);
});

test('duplicate request cannot start twice', async () => {
  const db = fakeDatabase();
  const requestId = crypto.randomUUID();

  const first = await quota.reserveFreeAnalysis(
    db,
    'user-3',
    requestId
  );

  const duplicate = await quota.reserveFreeAnalysis(
    db,
    'user-3',
    requestId
  );

  assert.equal(first.allowed, true);
  assert.equal(duplicate.allowed, false);
  assert.equal(duplicate.duplicate, true);
});

test('repeat success cannot count twice', async () => {
  const db = fakeDatabase();

  const reservation =
    await quota.reserveFreeAnalysis(db, 'user-4');

  const first = await quota.finalizeFreeAnalysis(
    db,
    'user-4',
    reservation.reservationId,
    true
  );

  const second = await quota.finalizeFreeAnalysis(
    db,
    'user-4',
    reservation.reservationId,
    true
  );

  assert.equal(first.counted, true);
  assert.equal(second.counted, true);
  assert.equal(
    db.usage.get('user-4:2026-10-27'),
    1
  );
});

test('expired reservation is not counted', async () => {
  const db = fakeDatabase();

  const reservation =
    await quota.reserveFreeAnalysis(db, 'user-5');

  db.reservations.get(reservation.reservationId)
    .active = false;

  const result = await quota.finalizeFreeAnalysis(
    db,
    'user-5',
    reservation.reservationId,
    true
  );

  assert.equal(result.counted, false);
  assert.equal(result.state, 'expired');
});

test('six concurrent reservations allow at most five', async () => {
  const db = fakeDatabase();

  const results = await Promise.all(
    Array.from({ length: 6 }, () =>
      quota.reserveFreeAnalysis(db, 'user-6')
    )
  );

  assert.equal(
    results.filter(r => r.allowed).length,
    5
  );

  assert.equal(
    results.filter(r => !r.allowed).length,
    1
  );
});

test('reservation cannot be finalized by other UID', async () => {
  const db = fakeDatabase();

  const reservation =
    await quota.reserveFreeAnalysis(db, 'owner');

  await assert.rejects(
    quota.finalizeFreeAnalysis(
      db,
      'attacker',
      reservation.reservationId,
      true
    ),
    /Reservation not found/
  );
});

test('invalid identifiers rejected', async () => {
  const db = fakeDatabase();

  await assert.rejects(
    quota.reserveFreeAnalysis(db, ''),
    /Firebase UID/
  );

  await assert.rejects(
    quota.reserveFreeAnalysis(db, 'user', 'invalid'),
    /Invalid request ID/
  );
});
