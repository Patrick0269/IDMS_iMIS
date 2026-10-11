import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';

Object.assign(process.env, {
  NODE_ENV: 'test',
  SUPABASE_URL: 'http://127.0.0.1:9',
  SUPABASE_SERVICE_ROLE_KEY: 'test-key-only',
  JWT_SECRET: 'test-secret-at-least-sixteen',
  SMTP_HOST: 'localhost',
  SMTP_USER: 'test@example.com',
  SMTP_PASSWORD: 'test-only',
  SMTP_FROM_EMAIL: 'test@example.com',
});

const { getSupabase } = await import('../dist/config/database.js');
const { default: authRoutes } = await import('../dist/modules/auth/routes/auth.routes.js');
const { completePasswordSetup } = await import('../dist/modules/auth/services/auth.service.js');
const { changeAuthenticatedPassword } = await import('../dist/services/password.service.js');
const { resolveStudentLoginEmail, requestVerifiedPasswordReset, normaliseStudentNumber, isValidStudentNumber } = await import('../dist/modules/auth/services/student-login.service.js');

function tableMock(records, onInsert = () => {}) {
  return table => {
    const filters = [];
    let updatePayload = null;
    const query = {
      select() { return this; },
      update(payload) { updatePayload = payload; return this; },
      ilike(field, value) { filters.push(row => String(row[field] ?? '').toLowerCase() === String(value).toLowerCase()); return this; },
      or(expression) {
        const clauses = String(expression).split(',').map(clause => clause.split('.ilike.'));
        filters.push(row => clauses.some(([field, value]) => String(row[field] ?? '').toLowerCase() === String(value ?? '').toLowerCase()));
        return this;
      },
      eq(field, value) { filters.push(row => row[field] === value); return this; },
      limit(size) { return Promise.resolve({ data: (records[table] ?? []).filter(row => filters.every(match => match(row))).slice(0, size), error: null }); },
      maybeSingle() {
        const row = (records[table] ?? []).filter(item => filters.every(match => match(item)))[0] ?? null;
        if (row && updatePayload) Object.assign(row, updatePayload);
        return Promise.resolve({ data: row, error: null });
      },
      insert(payload) { onInsert(table, payload); return Promise.resolve({ data: null, error: null }); },
    };
    return query;
  };
}

test('student recovery response is non-enumerating and account setup uses an email recovery link', async () => {
  const db = getSupabase();
  const originalFrom = db.from;
  const originalGetUserById = db.auth.admin.getUserById;
  const originalGenerateLink = db.auth.admin.generateLink;
  const originalUpdateUserById = db.auth.admin.updateUserById;
  const originalResetPasswordForEmail = db.auth.resetPasswordForEmail;
  const records = { students: [{ id: 'student-1', student_number: 'IDMC/2026/00001', user_id: null, student_status: 'ACTIVE' }] };
  const inserts = [];
  let dbCalls = 0;
  db.from = table => { dbCalls++; return tableMock(records, (name, payload) => inserts.push([name, payload]))(table); };

  const app = express();
  app.use(express.json());
  app.use('/auth', authRoutes);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const request = async payload => {
      const response = await fetch(`${base}/auth/password-reset`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      return { status: response.status, body: await response.json() };
    };
    const unknown = await request({ accountType: 'student', registrationNumber: 'INVALID', formFourYear: 2014, email: 'student@example.edu' });
    const unlinked = await request({ accountType: 'student', registrationNumber: 'IDMC/2026/00001', formFourYear: 2014, email: 'student@example.edu' });
    assert.equal(unknown.status, 200);
    assert.deepEqual(unlinked, unknown);

    const protectedChange = await fetch(`${base}/auth/change-password`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'CurrentPassword123', newPassword: 'NewPassword123' }),
    });
    assert.equal(protectedChange.status, 401, 'password changes require an authenticated session');

    dbCalls = 0;
    assert.equal(await resolveStudentLoginEmail('IDMC/2026/00001', 'idmc/2026/00001'), null);
    assert.ok(dbCalls > 0, 'the temporary number password is checked against an active, linked student account');

    records.students[0].user_id = 'user-1';
    records.students[0].registration_number = 'NS1179/0269/2020';
    records.students[0].applicant_id = 'applicant-1';
    records.students[0].first_name = 'Test';
    records.students[0].last_name = 'Student';
    records.academic_qualifications = [{ applicant_id: 'applicant-1', qualification_type: 'SECONDARY', completion_year: 2014 }];
    records.users = [{ id: 'user-1', auth_user_id: 'auth-1', status: 'ACTIVE', display_name: 'Test Student' }];
    db.auth.admin.getUserById = async id => ({ data: { user: { id, email: 'student@example.edu' } }, error: null });
    let generated;
    db.auth.admin.generateLink = async input => { generated = input; return { data: { properties: { action_link: 'https://auth.example/recovery-token' } }, error: null }; };
    const sent = [];
    assert.equal(await requestVerifiedPasswordReset({ accountType: 'student', registrationNumber: 'NS1179/0269/2020', formFourYear: 2013, email: 'student@example.edu' }, async message => sent.push(message)), false);
    assert.equal(sent.length, 0, 'incorrect Form Four year cannot receive a reset link');
    const studentVerified = await requestVerifiedPasswordReset({ accountType: 'student', registrationNumber: 'NS1179/0269/2020', formFourYear: 2014, email: 'student@example.edu' }, async message => sent.push(message));
    assert.equal(studentVerified, true);
    assert.equal(generated.type, 'recovery');
    assert.equal(generated.email, 'student@example.edu');
    assert.equal(sent[0].recipientEmail, 'student@example.edu');
    assert.equal(sent[0].recoveryUrl, 'https://auth.example/recovery-token');
    assert.equal(inserts.at(-1)[0], 'security_logs');
    assert.equal(inserts.at(-1)[1].event_code, 'PASSWORD_RESET_REQUESTED');

    let resetFallback;
    db.auth.resetPasswordForEmail = async (...args) => { resetFallback = args; return { error: null }; };
    const fallbackSent = await requestVerifiedPasswordReset(
      { accountType: 'student', registrationNumber: 'NS1179/0269/2020', formFourYear: 2014, email: 'student@example.edu' },
      async () => { throw Object.assign(new Error('SMTP unavailable'), { code: 'ECONNECTION' }); },
    );
    assert.equal(fallbackSent, true, 'Supabase Auth email is attempted when Worker SMTP fails');
    assert.equal(resetFallback[0], 'student@example.edu');
    assert.match(resetFallback[1].redirectTo, /set-password\.html$/);

    records.staff = [{ id: 'staff-1', user_id: 'user-1', email: 'student@example.edu', phone: '+255 712 345 678', staff_category: 'ACADEMIC', employment_status: 'ACTIVE', first_name: 'Test', last_name: 'Lecturer' }];
    assert.equal(await requestVerifiedPasswordReset({ accountType: 'lecturer', phone: '0712345670', email: 'student@example.edu' }, async message => sent.push(message)), false, 'wrong staff phone cannot receive a reset link');
    assert.equal(await requestVerifiedPasswordReset({ accountType: 'lecturer', phone: '0712345678', email: 'student@example.edu' }, async message => sent.push(message)), true);
    assert.equal(sent.length, 2);

    await completePasswordSetup('auth-1');
    assert.ok(records.users[0].password_changed_at);
    assert.equal(inserts.at(-1)[1].event_code, 'PASSWORD_SETUP_COMPLETED');

    let authUpdate;
    db.auth.admin.updateUserById = async (id, payload) => { authUpdate = { id, payload }; return { error: null }; };
    const authCalls = [];
    const createAuthClient = () => ({ auth: {
      signInWithPassword: async credentials => { authCalls.push(credentials); return { error: null }; },
      signOut: async () => ({ error: null }),
    } });
    await changeAuthenticatedPassword('auth-1', 'CurrentPassword123', 'NewPassword123', { source: 'test', ipAddress: '127.0.0.1' }, createAuthClient);
    assert.equal(authCalls[0].email, 'student@example.edu');
    assert.equal(authCalls[0].password, 'CurrentPassword123');
    assert.equal(authUpdate.id, 'auth-1');
    assert.equal(authUpdate.payload.password, 'NewPassword123');
    assert.equal(authUpdate.payload.app_metadata.idmc_student_first_login, false);
    assert.equal(inserts.at(-1)[1].event_code, 'PASSWORD_CHANGED');

    await assert.rejects(
      changeAuthenticatedPassword('auth-1', 'wrong-current', 'AnotherPassword123', { source: 'test' }, () => ({ auth: {
        signInWithPassword: async () => ({ error: new Error('bad password') }), signOut: async () => ({ error: null }),
      } })),
      error => error.statusCode === 401,
    );
    assert.equal(authUpdate.payload.password, 'NewPassword123', 'wrong current password cannot update Auth');
  } finally {
    db.from = originalFrom;
    db.auth.admin.getUserById = originalGetUserById;
    db.auth.admin.generateLink = originalGenerateLink;
    db.auth.admin.updateUserById = originalUpdateUserById;
    db.auth.resetPasswordForEmail = originalResetPasswordForEmail;
    await new Promise(resolve => server.close(resolve));
  }
});

test('historical student number works as a temporary password only while first-login change is required', async () => {
  const db = getSupabase();
  const originalFrom = db.from;
  const originalGetUserById = db.auth.admin.getUserById;
  const originalUpdateUserById = db.auth.admin.updateUserById;
  const number = 'NS2929/2000/2000';
  const records = {
    students: [{ id: 'student-2', student_number: 'IDMC/2026/00002', registration_number: number, user_id: 'user-2', student_status: 'ACTIVE' }],
    // Historical accounts can have login history even though the student has
    // never changed the password to the registration-number temporary value.
    users: [{ id: 'user-2', auth_user_id: 'auth-2', status: 'ACTIVE', password_changed_at: null, last_login_at: '2025-03-01T10:00:00.000Z' }],
    user_roles: [{ user_id: 'user-2', status: 'ACTIVE', roles: { role_code: 'STUDENT' } }],
  };
  const identity = { id: 'auth-2', email: 'student@example.edu', app_metadata: {} };
  let initialPassword = '';
  db.from = tableMock(records);
  db.auth.admin.getUserById = async () => ({ data: { user: identity }, error: null });
  db.auth.admin.updateUserById = async (_id, input) => {
    initialPassword = input.password;
    identity.app_metadata = input.app_metadata;
    return { data: { user: identity }, error: null };
  };
  try {
    const spacedNumber = ' NS2929 / 2000 / 2000 ';
    assert.equal(normaliseStudentNumber(spacedNumber), number, 'spaces around and within the formatted number are ignored');
    assert.equal(isValidStudentNumber(spacedNumber), true, 'a correctly formatted number remains valid with user-entered spacing');
    assert.equal(await resolveStudentLoginEmail(number.toLowerCase(), number.toLowerCase()), 'student@example.edu');
    assert.equal(initialPassword, number, 'initialization uses the registration number as the temporary password');
    assert.equal(identity.app_metadata.idmc_student_first_login, true, 'first login is marked for a forced password change');
    assert.equal(await resolveStudentLoginEmail(number, number), 'student@example.edu');
    assert.equal(await resolveStudentLoginEmail(spacedNumber, spacedNumber), 'student@example.edu', 'login accepts the same student number and temporary password with spacing');

    identity.app_metadata.idmc_student_first_login = false;
    assert.equal(await resolveStudentLoginEmail(number, number), null, 'the temporary number password stops working after the required change');
  } finally {
    db.from = originalFrom;
    db.auth.admin.getUserById = originalGetUserById;
    db.auth.admin.updateUserById = originalUpdateUserById;
  }
});
