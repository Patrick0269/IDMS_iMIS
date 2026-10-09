import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';

Object.assign(process.env, {
  NODE_ENV: 'test',
  SUPABASE_URL: 'http://127.0.0.1:9',
  SUPABASE_SERVICE_ROLE_KEY: 'test-key-only',
  JWT_SECRET: 'test-secret-at-least-sixteen',
  SMTP_HOST: 'localhost',
  SMTP_USER: 'test@example.com',
  SMTP_PASSWORD: 'test-only',
  SMTP_FROM_EMAIL: 'test@example.com'
});

const { getSupabase } = await import('../dist/config/database.js');
const { authenticate } = await import('../dist/middleware/auth.js');
const { escapeIlikeLiteral } = await import('../dist/utils/security.js');
const { errorHandler } = await import('../dist/middleware/errorHandler.js');

function postgresIlikeRegex(pattern) {
  let source = '^';
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (character === '\\' && index + 1 < pattern.length) {
      source += pattern[++index].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    } else if (character === '%') source += '.*';
    else if (character === '_') source += '.';
    else source += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${source}$`, 'i');
}

test('email healing requires confirmation and treats wildcard characters as literal address text', async () => {
  const db = getSupabase();
  const oldFrom = db.from;
  const oldGetUser = db.auth.getUser;
  const user = { id: 'user-1', auth_user_id: null, user_number: 'U1', email: 'owner@example.edu', first_name: 'Owner', last_name: 'User', status: 'ACTIVE' };
  let emailConfirmedAt = null;
  let authEmail = 'owner@example.edu';
  let emailLookups = 0;
  let updates = 0;
  let simulateConcurrentLink = false;

  db.auth.getUser = async () => ({ data: { user: { id: 'auth-1', email: authEmail, email_confirmed_at: emailConfirmedAt } }, error: null });
  db.from = table => {
    assert.equal(table, 'users');
    let filters = [];
    let mode = 'select';
    let payload = null;
    let single = false;
    let maxRows = Infinity;
    const query = {
      select() { return this; },
      eq(column, value) { filters.push(row => row[column] === value); return this; },
      is(column, value) {
        if (column === 'auth_user_id' && simulateConcurrentLink) {
          user.auth_user_id = 'auth-racer';
          simulateConcurrentLink = false;
        }
        filters.push(row => row[column] === value);
        return this;
      },
      ilike(column, value) { emailLookups++; const pattern = postgresIlikeRegex(String(value)); filters.push(row => pattern.test(String(row[column] || ''))); return this; },
      limit(value) { maxRows = value; return this; },
      update(value) { mode = 'update'; payload = value; return this; },
      maybeSingle() { single = true; return this.execute(); },
      single() { single = true; return this.execute(); },
      execute() {
        let rows = user && filters.every(predicate => predicate(user)) ? [user] : [];
        if (mode === 'update' && rows.length) {
          updates++;
          Object.assign(user, payload);
        }
        rows = rows.slice(0, maxRows);
        return Promise.resolve({ data: single ? rows[0] ?? null : rows, error: null });
      },
      then(resolve, reject) { return this.execute().then(resolve, reject); }
    };
    return query;
  };

  const app = express();
  app.get('/protected', authenticate, (req, res) => res.json({ userId: req.user.id, emailVerified: req.authUser.emailVerified }));
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}/protected`;

  try {
    let response = await fetch(url, { headers: { authorization: 'Bearer test' } });
    assert.equal(response.status, 403, 'unconfirmed email cannot claim an IDMC profile');
    assert.equal(emailLookups, 0, 'unconfirmed email is not used for profile matching');
    assert.equal(updates, 0, 'unconfirmed identity does not mutate user linkage');
    assert.equal(user.auth_user_id, null);

    emailConfirmedAt = '2026-01-01T00:00:00Z';
    authEmail = 'victim_@example.edu';
    user.email = 'victimA@example.edu';
    response = await fetch(url, { headers: { authorization: 'Bearer test' } });
    assert.equal(response.status, 403, 'underscore in an Auth address is not a wildcard');
    assert.equal(updates, 0, 'a wildcard-like address cannot claim a near match');

    authEmail = 'owner%@example.edu';
    user.email = 'owner@example.edu';
    response = await fetch(url, { headers: { authorization: 'Bearer test' } });
    assert.equal(response.status, 403, 'percent in an Auth address is not a wildcard');
    assert.equal(updates, 0, 'percent wildcard-like address cannot claim a near match');

    authEmail = 'owner@example.edu';
    user.email = authEmail;
    user.auth_user_id = 'auth-someone-else';
    response = await fetch(url, { headers: { authorization: 'Bearer test' } });
    assert.equal(response.status, 403, 'a confirmed email cannot take over a profile linked to another Auth identity');
    assert.equal(user.auth_user_id, 'auth-someone-else');
    assert.equal(updates, 0, 'linked profiles are never rewritten during email healing');

    user.auth_user_id = null;
    simulateConcurrentLink = true;
    response = await fetch(url, { headers: { authorization: 'Bearer test' } });
    assert.equal(response.status, 403, 'a concurrent owner assignment prevents the conditional repair');
    assert.equal(user.auth_user_id, 'auth-racer', 'conditional repair preserves the concurrent owner');
    assert.equal(updates, 0, 'a losing concurrent repair performs no update');

    authEmail = 'literal_%@example.edu';
    user.email = authEmail;
    user.auth_user_id = null;
    response = await fetch(url, { headers: { authorization: 'Bearer test' } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { userId: 'user-1', emailVerified: true });
    assert.equal(emailLookups, 5);
    assert.equal(updates, 1);
    assert.equal(user.auth_user_id, 'auth-1');
  } finally {
    db.from = oldFrom;
    db.auth.getUser = oldGetUser;
    await new Promise(resolve => server.close(resolve));
  }
});

test('escaped Auth addresses use literal PostgreSQL ILIKE matching for underscore and percent', async () => {
  const db = new PGlite();
  try {
    const underscore = escapeIlikeLiteral('victim_@example.edu');
    const percent = escapeIlikeLiteral('owner%@example.edu');
    const result = await db.query(`SELECT
      'victimA@example.edu' ILIKE $1 AS underscore_near_match,
      'victim_@example.edu' ILIKE $1 AS underscore_exact_match,
      'owner@example.edu' ILIKE $2 AS percent_near_match,
      'owner%@example.edu' ILIKE $2 AS percent_exact_match`, [underscore, percent]);
    assert.equal(result.rows[0].underscore_near_match, false);
    assert.equal(result.rows[0].underscore_exact_match, true);
    assert.equal(result.rows[0].percent_near_match, false);
    assert.equal(result.rows[0].percent_exact_match, true);
  } finally {
    await db.close();
  }
});
