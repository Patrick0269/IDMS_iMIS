import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

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
const { default: applicantRouter } = await import('../dist/modules/applicant-self-service/applicant-self-service.routes.js');
const { errorHandler } = await import('../dist/middleware/errorHandler.js');

test('applicant contact email must be the verified Auth email on create and update', async () => {
  const db = getSupabase();
  const oldFrom = db.from;
  const oldGetUser = db.auth.getUser;
  const tables = {
    users: [{ id: 'user-1', auth_user_id: 'auth-1', user_number: 'U1', email: 'verified@example.edu', first_name: 'A', last_name: 'Student', status: 'ACTIVE' }],
    applicants: []
  };
  let emailConfirmedAt = null;
  let writes = 0;
  db.auth.getUser = async () => ({ data: { user: { id: 'auth-1', email: 'verified@example.edu', email_confirmed_at: emailConfirmedAt } }, error: null });
  db.from = table => {
    let predicates = [];
    let mode = 'select';
    let payload = null;
    let single = false;
    const query = {
      select() { return this; },
      eq(column, expected) { predicates.push(row => row[column] === expected); return this; },
      insert(value) { mode = 'insert'; payload = value; return this; },
      update(value) { mode = 'update'; payload = value; return this; },
      maybeSingle() { single = true; return this; },
      single() { single = true; return this; },
      then(resolve, reject) {
        try {
          const rows = tables[table] ?? (tables[table] = []);
          let selected = rows.filter(row => predicates.every(predicate => predicate(row)));
          if (mode === 'insert') {
            writes++;
            selected = [{ id: `applicant-${writes}`, ...payload }];
            rows.push(...selected);
          } else if (mode === 'update') {
            writes++;
            for (const row of selected) Object.assign(row, payload);
          }
          const result = { data: single ? selected[0] ?? null : selected, error: null };
          return Promise.resolve(result).then(resolve, reject);
        } catch (error) {
          return Promise.reject(error).then(resolve, reject);
        }
      }
    };
    return query;
  };

  const app = express();
  app.use(express.json());
  app.use('/applicant', applicantRouter);
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function post(path, body) {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  }
  async function patch(path, body) {
    const response = await fetch(`${base}${path}`, {
      method: 'PATCH',
      headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  }

  try {
    let response = await post('/applicant/applicants', { firstName: 'A', lastName: 'Student', email: 'recipient@external.test' });
    assert.equal(response.status, 403, 'unverified Auth email cannot create an applicant profile');
    assert.equal(writes, 0);

    emailConfirmedAt = '2026-01-01T00:00:00Z';
    response = await post('/applicant/applicants', { firstName: 'A', lastName: 'Student', email: 'recipient@external.test' });
    assert.equal(response.status, 400, 'an alternate unverified recipient is rejected');
    assert.equal(writes, 0);

    response = await post('/applicant/applicants', { firstName: 'A', lastName: 'Student' });
    assert.equal(response.status, 201);
    assert.equal(response.body.data.email, 'verified@example.edu');
    const applicantId = response.body.data.id;
    const beforeUpdate = writes;

    response = await patch(`/applicant/applicants/${applicantId}`, { firstName: 'A', lastName: 'Student', email: 'recipient@external.test' });
    assert.equal(response.status, 400, 'an applicant cannot redirect the verified contact address');
    assert.equal(writes, beforeUpdate);
    assert.equal(tables.applicants[0].email, 'verified@example.edu');

    response = await patch(`/applicant/applicants/${applicantId}`, { firstName: 'Updated', lastName: 'Student' });
    assert.equal(response.status, 200);
    assert.equal(response.body.data.email, 'verified@example.edu');
  } finally {
    db.from = oldFrom;
    db.auth.getUser = oldGetUser;
    await new Promise(resolve => server.close(resolve));
  }
});
