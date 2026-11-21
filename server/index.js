// Punchwell — self-service clock-in / clock-out for small teams.
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createRouter, createSessions, startServer, serveStatic, fail, hashPassword, verifyPassword,
  RawResponse, toCsv, rateLimiter, clientIp, STOP
} from './lib/http.js';
import { localDate, addDays, hhmm } from './lib/time.js';
import { openDb, getSettings, setSettings, audit, currentState, allowedActions, buildDays, summarize } from './db.js';
import { seedDemo } from './seed.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = resolve(process.env.DATA_DIR || join(ROOT, 'data'));
const BRAND_DIR = resolve(process.env.BRAND_DIR || join(ROOT, 'brand'));
const DEMO = process.env.DEMO === '1' || process.env.DEMO === 'true';
const DEMO_RESET_HOURS = Number(process.env.DEMO_RESET_HOURS || 0);
const DB_FILE = join(DATA_DIR, 'punchwell.db');
mkdirSync(DATA_DIR, { recursive: true });

function loadSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const f = join(DATA_DIR, '.session-secret');
  if (!existsSync(f)) writeFileSync(f, randomBytes(32).toString('hex'), { mode: 0o600 });
  return readFileSync(f, 'utf8').trim();
}
function loadBrand() {
  const f = join(BRAND_DIR, 'brand.json');
  if (!existsSync(f)) return {};
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch (e) { console.warn('brand.json is invalid:', e.message); return {}; }
}

const brand = loadBrand();
const APP_NAME = process.env.APP_NAME || brand.appName || 'Punchwell';
let db;
function init() {
  db = openDb(DB_FILE);
  const empty = !db.prepare('SELECT 1 FROM employees LIMIT 1').get() && !db.prepare('SELECT 1 FROM admins LIMIT 1').get();
  if (empty && brand.companyName) setSettings(db, { company_name: brand.companyName });
  if (empty && process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
    db.prepare('INSERT INTO admins (name, email, password_hash, created_at) VALUES (?, ?, ?, ?)').run('Administrator', process.env.ADMIN_EMAIL, hashPassword(process.env.ADMIN_PASSWORD), Date.now());
  }
  if (empty && DEMO) { seedDemo(db, { brandName: brand.companyName }); console.log('Seeded demo data.'); }
}
init();
if (DEMO && DEMO_RESET_HOURS > 0) {
  setInterval(() => {
    try { db.close(); for (const s of ['', '-wal', '-shm']) rmSync(DB_FILE + s, { force: true }); init(); console.log('Demo data reset.'); }
    catch (e) { console.error('Demo reset failed', e); }
  }, DEMO_RESET_HOURS * 3600e3).unref();
}

const secret = loadSecret();
const sessions = createSessions(secret, 'pw_sid');
const kioskSessions = createSessions(secret + ':kiosk', 'pw_kiosk', 365);
const pinLimiter = rateLimiter(12, 5 * 60e3);
const loginLimiter = rateLimiter(10, 10 * 60e3);
const r = createRouter();

/* ---------- guards ---------- */
const auth = (c) => { c.user = sessions.read(c.req); if (!c.user) fail(401, 'Please sign in'); };
const admin = (c) => { auth(c); if (c.user.role !== 'admin') fail(403, 'Admins only'); };
const employee = (c) => { auth(c); if (c.user.role !== 'employee') fail(403, 'Employees only'); };
const kiosk = (c) => {
  c.kiosk = kioskSessions.read(c.req);
  if (!c.kiosk) { const u = sessions.read(c.req); if (u?.role === 'admin') c.kiosk = { by: u.email }; }
  if (!c.kiosk) fail(401, 'This device is not activated as a kiosk');
};
const S = () => getSettings(db);
const cleanEmp = (e) => e && ({ id: e.id, code: e.code, name: e.name, email: e.email, phone: e.phone, department: e.department, title: e.title, photo: e.photo, active: !!e.active, created_at: e.created_at });

/* ---------- meta & auth ---------- */
r.get('/api/meta', () => {
  const s = S();
  const hasAdmin = !!db.prepare('SELECT 1 FROM admins LIMIT 1').get();
  return {
    appName: APP_NAME, companyName: s.company_name, tagline: brand.tagline || 'Clock in. Clock out. Done.',
    logo: s.logo || (brand.logo ? '/brand/' + brand.logo : '/logo.svg'),
    accent: s.accent || brand.accent || '', accentInk: brand.accentInk || '', theme: brand.theme || '',
    timezone: s.timezone, needsSetup: !hasAdmin,
    allowMobile: s.allow_mobile === '1', allowBreaks: s.allow_breaks === '1', requirePhoto: s.require_photo === '1', requireLocation: s.require_location === '1',
    demo: DEMO ? { admin: { email: 'admin@demo.local', password: 'demo1234' }, employee: { code: 'E101', pin: '1234' } } : null
  };
});

r.post('/api/setup', (c) => {
  if (db.prepare('SELECT 1 FROM admins LIMIT 1').get()) fail(409, 'Setup is already complete');
  const { name, email, password, company_name, timezone } = c.body;
  if (!email || !password || String(password).length < 8) fail(400, 'Enter an email and a password of at least 8 characters');
  db.prepare('INSERT INTO admins (name, email, password_hash, created_at) VALUES (?, ?, ?, ?)').run(name || 'Administrator', email, hashPassword(password), Date.now());
  setSettings(db, { company_name: company_name || 'My Company', timezone: timezone || 'UTC' });
  const a = db.prepare('SELECT * FROM admins WHERE email = ?').get(email);
  sessions.issue(c.res, { role: 'admin', id: a.id, name: a.name, email: a.email });
  return { ok: true };
});

r.post('/api/auth/login', (c) => {
  if (!loginLimiter('login:' + clientIp(c.req))) fail(429, 'Too many attempts. Try again in a few minutes.');
  const a = db.prepare('SELECT * FROM admins WHERE email = ?').get(String(c.body.email || '').trim());
  if (!a || !verifyPassword(c.body.password, a.password_hash)) fail(401, 'Email or password is incorrect');
  sessions.issue(c.res, { role: 'admin', id: a.id, name: a.name, email: a.email });
  return { role: 'admin' };
});
r.post('/api/auth/employee', (c) => {
  if (!pinLimiter('emp:' + clientIp(c.req))) fail(429, 'Too many attempts. Try again in a few minutes.');
  if (S().allow_mobile !== '1') fail(403, 'Personal sign-in is turned off. Use the kiosk.');
  const e = db.prepare('SELECT * FROM employees WHERE code = ? AND active = 1').get(String(c.body.code || '').trim());
  if (!e || !verifyPassword(c.body.pin, e.pin_hash)) fail(401, 'Employee ID or PIN is incorrect');
  sessions.issue(c.res, { role: 'employee', id: e.id, name: e.name });
  return { role: 'employee' };
});
r.post('/api/auth/logout', (c) => { sessions.clear(c.res); return { ok: true }; });
r.get('/api/auth/me', (c) => ({ user: sessions.read(c.req) || null, kiosk: !!kioskSessions.read(c.req) }));

/* ---------- punching ---------- */
function punch(employeeId, type, { source, lat, lng, accuracy, photo, note, actor }) {
  const s = S();
  const e = db.prepare('SELECT * FROM employees WHERE id = ? AND active = 1').get(employeeId);
  if (!e) fail(404, 'Employee not found');
  const { state } = currentState(db, employeeId);
  const allowed = allowedActions(state, s.allow_breaks === '1');
  if (!type) type = allowed[0];
  if (!allowed.includes(type)) fail(409, `You can't do that right now (current status: ${state}).`);
  if (s.require_photo === '1' && source !== 'admin' && !photo) fail(400, 'A photo is required to clock in.');
  if (s.require_location === '1' && source === 'mobile' && (lat == null || lng == null)) fail(400, 'Location is required. Allow location access and try again.');
  if (photo && (typeof photo !== 'string' || !photo.startsWith('data:image/') || photo.length > 400_000)) fail(400, 'Photo is invalid or too large');
  const ts = Date.now();
  db.prepare('INSERT INTO punches (employee_id, type, ts, source, lat, lng, accuracy, photo, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(employeeId, type, ts, source, lat ?? null, lng ?? null, accuracy ?? null, photo ?? null, note ?? null, ts);
  if (actor) audit(db, actor, 'punch', { employeeId, type });
  const today = localDate(ts, s.timezone);
  const [day] = buildDays(db, s, { from: today, to: today, employeeIds: [employeeId] });
  return { type, ts, employee: { id: e.id, name: e.name, photo: e.photo, title: e.title }, state: currentState(db, employeeId), today: day };
}

r.post('/api/kiosk/activate', admin, (c) => { kioskSessions.issue(c.res, { by: c.user.email, at: Date.now() }); audit(db, c.user.email, 'kiosk.activate'); return { ok: true }; });
r.post('/api/kiosk/deactivate', (c) => { kioskSessions.clear(c.res); return { ok: true }; });
r.get('/api/kiosk/roster', kiosk, () => {
  const emps = db.prepare('SELECT id, code, name, department, title, photo FROM employees WHERE active = 1 ORDER BY name').all();
  return emps.map((e) => ({ ...e, ...currentState(db, e.id) }));
});
r.post('/api/kiosk/punch', kiosk, (c) => {
  const { employee_id, code, pin, type, photo } = c.body;
  const e = employee_id ? db.prepare('SELECT * FROM employees WHERE id = ? AND active = 1').get(employee_id)
    : db.prepare('SELECT * FROM employees WHERE code = ? AND active = 1').get(String(code || '').trim());
  if (!pinLimiter('kiosk:' + (e?.id ?? clientIp(c.req)))) fail(429, 'Too many wrong PINs. Ask a manager for help.');
  if (!e || !verifyPassword(pin, e.pin_hash)) fail(401, 'Wrong PIN. Try again.');
  if (c.body.check) { const st = currentState(db, e.id); return { employee: cleanEmp(e), state: st, actions: allowedActions(st.state, S().allow_breaks === '1') }; }
  return punch(e.id, type, { source: 'kiosk', photo });
});

r.get('/api/me', employee, (c) => {
  const s = S();
  const e = db.prepare('SELECT * FROM employees WHERE id = ?').get(c.user.id);
  if (!e || !e.active) fail(401, 'Your account is inactive');
  const st = currentState(db, e.id);
  const today = localDate(Date.now(), s.timezone);
  const days = buildDays(db, s, { from: addDays(today, -13), to: today, employeeIds: [e.id] }).reverse();
  const punches = db.prepare('SELECT id, type, ts, source FROM punches WHERE employee_id = ? ORDER BY ts DESC LIMIT 12').all(e.id);
  return { employee: cleanEmp(e), state: st, actions: allowedActions(st.state, s.allow_breaks === '1'), days, punches, schedule: { start: s.work_start, end: s.work_end } };
});
r.post('/api/me/punch', employee, (c) => {
  if (S().allow_mobile !== '1') fail(403, 'Personal clock-in is turned off. Use the kiosk.');
  const { type, lat, lng, accuracy, photo } = c.body;
  return punch(c.user.id, type, { source: 'mobile', lat, lng, accuracy, photo });
});
r.post('/api/me/pin', employee, (c) => {
  const e = db.prepare('SELECT * FROM employees WHERE id = ?').get(c.user.id);
  if (!verifyPassword(c.body.current, e.pin_hash)) fail(401, 'Current PIN is incorrect');
  if (!/^\d{4,8}$/.test(String(c.body.next || ''))) fail(400, 'PIN must be 4–8 digits');
  db.prepare('UPDATE employees SET pin_hash = ? WHERE id = ?').run(hashPassword(c.body.next), e.id);
  return { ok: true };
});

/* ---------- admin: dashboard ---------- */
r.get('/api/dashboard', admin, () => {
  const s = S();
  const now = Date.now();
  const today = localDate(now, s.timezone);
  const rows = buildDays(db, s, { from: today, to: today, now });
  const counts = { working: 0, on_break: 0, present: 0, late: 0, pending: 0, absent: 0, off: 0, missing_out: 0 };
  for (const x of rows) counts[x.status] = (counts[x.status] || 0) + 1;
  const total = db.prepare('SELECT COUNT(*) n FROM employees WHERE active = 1').get().n;
  const onSite = counts.working + counts.on_break;
  const arrived = rows.filter((x) => x.first_in).length;
  const lateToday = rows.filter((x) => x.late).length;
  const from = addDays(today, -13);
  const hist = buildDays(db, s, { from, to: today, now });
  const trend = [];
  for (let d = from; d <= today; d = addDays(d, 1)) {
    const day = hist.filter((x) => x.date === d);
    trend.push({ date: d, present: day.filter((x) => x.first_in).length, late: day.filter((x) => x.late).length, scheduled: day.some((x) => x.scheduled), hours: Math.round(day.reduce((a, b) => a + b.worked_min, 0) / 60) });
  }
  const activity = db.prepare(`SELECT p.id, p.type, p.ts, p.source, e.name, e.photo, e.code FROM punches p JOIN employees e ON e.id = p.employee_id ORDER BY p.ts DESC, p.id DESC LIMIT 14`).all();
  return {
    today, total, onSite, arrived, lateToday, counts,
    live: rows.filter((x) => x.first_in).sort((a, b) => (b.open - a.open) || (a.first_in - b.first_in)),
    notIn: rows.filter((x) => !x.first_in && x.scheduled).map((x) => ({ employee_id: x.employee_id, name: x.name, department: x.department, photo: x.photo, code: x.code })),
    trend, activity
  };
});

/* ---------- admin: employees ---------- */
r.get('/api/employees', admin, () => db.prepare('SELECT * FROM employees ORDER BY active DESC, name').all().map((e) => ({ ...cleanEmp(e), ...currentState(db, e.id) })));
function validateEmployee(b) {
  if (!String(b.name || '').trim()) fail(400, 'Name is required');
  if (!String(b.code || '').trim()) fail(400, 'Employee ID is required');
  if (b.photo && (!String(b.photo).startsWith('data:image/') || b.photo.length > 400_000)) fail(400, 'Photo is invalid or too large');
}
r.post('/api/employees', admin, (c) => {
  const b = c.body; validateEmployee(b);
  if (!/^\d{4,8}$/.test(String(b.pin || ''))) fail(400, 'PIN must be 4–8 digits');
  try {
    const id = db.prepare('INSERT INTO employees (code, name, email, phone, department, title, pin_hash, photo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(b.code.trim(), b.name.trim(), b.email || null, b.phone || null, b.department || null, b.title || null, hashPassword(b.pin), b.photo || null, Date.now()).lastInsertRowid;
    audit(db, c.user.email, 'employee.create', { id: Number(id), code: b.code });
    return cleanEmp(db.prepare('SELECT * FROM employees WHERE id = ?').get(id));
  } catch (e) { if (String(e.message).includes('UNIQUE')) fail(409, 'That Employee ID is already in use'); throw e; }
});
r.put('/api/employees/:id', admin, (c) => {
  const b = c.body; validateEmployee(b);
  const cur = db.prepare('SELECT * FROM employees WHERE id = ?').get(c.params.id);
  if (!cur) fail(404, 'Employee not found');
  try {
    db.prepare('UPDATE employees SET code = ?, name = ?, email = ?, phone = ?, department = ?, title = ?, photo = ?, active = ? WHERE id = ?')
      .run(b.code.trim(), b.name.trim(), b.email || null, b.phone || null, b.department || null, b.title || null, b.photo === undefined ? cur.photo : (b.photo || null), b.active === false ? 0 : 1, cur.id);
  } catch (e) { if (String(e.message).includes('UNIQUE')) fail(409, 'That Employee ID is already in use'); throw e; }
  if (b.pin) {
    if (!/^\d{4,8}$/.test(String(b.pin))) fail(400, 'PIN must be 4–8 digits');
    db.prepare('UPDATE employees SET pin_hash = ? WHERE id = ?').run(hashPassword(b.pin), cur.id);
  }
  audit(db, c.user.email, 'employee.update', { id: cur.id });
  return cleanEmp(db.prepare('SELECT * FROM employees WHERE id = ?').get(cur.id));
});
r.delete('/api/employees/:id', admin, (c) => {
  db.prepare('DELETE FROM employees WHERE id = ?').run(c.params.id);
  audit(db, c.user.email, 'employee.delete', { id: Number(c.params.id) });
  return { ok: true };
});
r.post('/api/employees/import', admin, (c) => {
  const rows = Array.isArray(c.body.rows) ? c.body.rows : [];
  const ins = db.prepare('INSERT OR IGNORE INTO employees (code, name, email, phone, department, title, pin_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  let added = 0;
  db.exec('BEGIN');
  try {
    for (const x of rows.slice(0, 2000)) {
      if (!x.code || !x.name) continue;
      const pin = /^\d{4,8}$/.test(String(x.pin || '')) ? String(x.pin) : String(Math.floor(1000 + Math.random() * 9000));
      added += Number(ins.run(String(x.code).trim(), String(x.name).trim(), x.email || null, x.phone || null, x.department || null, x.title || null, hashPassword(pin), Date.now()).changes);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  audit(db, c.user.email, 'employee.import', { added });
  return { added, skipped: rows.length - added };
});

/* ---------- admin: timesheets & punches ---------- */
r.get('/api/timesheets', admin, (c) => {
  const s = S();
  const today = localDate(Date.now(), s.timezone);
  const from = c.query.from || addDays(today, -6), to = c.query.to || today;
  const ids = c.query.employee ? [Number(c.query.employee)] : undefined;
  return { from, to, rows: buildDays(db, s, { from, to, employeeIds: ids }).filter((x) => c.query.all === '1' || x.status !== 'off') };
});
r.get('/api/punches', admin, (c) => {
  const s = S();
  const { employee, date } = c.query;
  if (!employee || !date) fail(400, 'employee and date are required');
  const from = Date.parse(date + 'T00:00:00Z') - 864e5, to = Date.parse(date + 'T23:59:59Z') + 864e5;
  return db.prepare('SELECT id, type, ts, source, lat, lng, accuracy, photo, note, edited_by FROM punches WHERE employee_id = ? AND ts BETWEEN ? AND ? ORDER BY ts, id').all(employee, from, to)
    .filter((p) => localDate(p.ts, s.timezone) === date);
});
r.post('/api/punches', admin, (c) => {
  const { employee_id, type, ts, note } = c.body;
  if (!['in', 'out', 'break_start', 'break_end'].includes(type)) fail(400, 'Invalid punch type');
  if (!Number.isFinite(Number(ts))) fail(400, 'Invalid time');
  if (!db.prepare('SELECT 1 FROM employees WHERE id = ?').get(employee_id)) fail(404, 'Employee not found');
  db.prepare('INSERT INTO punches (employee_id, type, ts, source, note, edited_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(employee_id, type, Number(ts), 'admin', note || null, c.user.email, Date.now());
  audit(db, c.user.email, 'punch.add', { employee_id, type, ts });
  return { ok: true };
});
r.put('/api/punches/:id', admin, (c) => {
  const { type, ts, note } = c.body;
  if (type && !['in', 'out', 'break_start', 'break_end'].includes(type)) fail(400, 'Invalid punch type');
  const p = db.prepare('SELECT * FROM punches WHERE id = ?').get(c.params.id);
  if (!p) fail(404, 'Punch not found');
  db.prepare('UPDATE punches SET type = ?, ts = ?, note = ?, edited_by = ? WHERE id = ?').run(type || p.type, Number(ts) || p.ts, note ?? p.note, c.user.email, p.id);
  audit(db, c.user.email, 'punch.edit', { id: p.id, from: { type: p.type, ts: p.ts }, to: { type, ts } });
  return { ok: true };
});
r.delete('/api/punches/:id', admin, (c) => {
  const p = db.prepare('SELECT * FROM punches WHERE id = ?').get(c.params.id);
  if (!p) fail(404, 'Punch not found');
  db.prepare('DELETE FROM punches WHERE id = ?').run(p.id);
  audit(db, c.user.email, 'punch.delete', { id: p.id, employee_id: p.employee_id, type: p.type, ts: p.ts });
  return { ok: true };
});

/* ---------- admin: reports ---------- */
const fmtT = (ts, tz) => ts ? new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ts) : '';
r.get('/api/reports/summary', admin, (c) => {
  const s = S();
  const today = localDate(Date.now(), s.timezone);
  const from = c.query.from || today.slice(0, 8) + '01', to = c.query.to || today;
  const rows = buildDays(db, s, { from, to });
  const sum = summarize(rows);
  if (c.query.format === 'csv') {
    return new RawResponse(toCsv(sum, [
      { label: 'Employee ID', key: 'code' }, { label: 'Name', key: 'name' }, { label: 'Department', key: 'department' },
      { label: 'Scheduled days', key: 'scheduled_days' }, { label: 'Days present', key: 'present' }, { label: 'Days absent', key: 'absent' },
      { label: 'Late arrivals', key: 'late' }, { label: 'Late minutes', key: 'late_min' }, { label: 'Missing clock-outs', key: 'missing_out' },
      { label: 'Hours worked', value: (x) => (x.worked_min / 60).toFixed(2) }, { label: 'Overtime hours', value: (x) => (x.overtime_min / 60).toFixed(2) },
      { label: 'Average clock-in', value: (x) => hhmm(x.avg_in_min) }, { label: 'Attendance rate %', value: (x) => x.attendance_rate == null ? '' : Math.round(x.attendance_rate * 100) }
    ]), 'text/csv; charset=utf-8', `attendance-summary_${from}_${to}.csv`);
  }
  const daily = {};
  for (const x of rows) { const d = daily[x.date] ||= { date: x.date, present: 0, late: 0, absent: 0 }; if (x.first_in) d.present++; if (x.late) d.late++; if (x.status === 'absent') d.absent++; }
  return { from, to, summary: sum, daily: Object.values(daily).sort((a, b) => a.date.localeCompare(b.date)) };
});
r.get('/api/reports/timesheet.csv', admin, (c) => {
  const s = S();
  const today = localDate(Date.now(), s.timezone);
  const from = c.query.from || addDays(today, -6), to = c.query.to || today;
  const rows = buildDays(db, s, { from, to, employeeIds: c.query.employee ? [Number(c.query.employee)] : undefined }).filter((x) => x.status !== 'off' || x.punches);
  return new RawResponse(toCsv(rows, [
    { label: 'Date', key: 'date' }, { label: 'Employee ID', key: 'code' }, { label: 'Name', key: 'name' }, { label: 'Department', key: 'department' },
    { label: 'Status', key: 'status' }, { label: 'First in', value: (x) => fmtT(x.first_in, s.timezone) }, { label: 'Last out', value: (x) => fmtT(x.last_out, s.timezone) },
    { label: 'Break minutes', key: 'break_min' }, { label: 'Worked hours', value: (x) => (x.worked_min / 60).toFixed(2) },
    { label: 'Late minutes', key: 'late_min' }, { label: 'Overtime hours', value: (x) => (x.overtime_min / 60).toFixed(2) }
  ]), 'text/csv; charset=utf-8', `timesheet_${from}_${to}.csv`);
});
r.get('/api/audit', admin, () => db.prepare('SELECT * FROM audit ORDER BY ts DESC LIMIT 200').all());

/* ---------- admin: settings ---------- */
r.get('/api/settings', admin, () => S());
r.put('/api/settings', admin, (c) => {
  const b = c.body;
  if (b.timezone) { try { new Intl.DateTimeFormat('en', { timeZone: b.timezone }); } catch { fail(400, 'Unknown timezone'); } }
  if (b.logo && (!String(b.logo).startsWith('data:image/') || b.logo.length > 300_000)) fail(400, 'Logo must be an image under 200 KB');
  if (b.accent && !/^#[0-9a-f]{6}$/i.test(b.accent)) fail(400, 'Accent must be a hex colour like #2563eb');
  setSettings(db, b);
  audit(db, c.user.email, 'settings.update', Object.keys(b));
  return S();
});
r.get('/api/admins', admin, () => db.prepare('SELECT id, name, email, created_at FROM admins ORDER BY id').all());
r.post('/api/admins', admin, (c) => {
  const { name, email, password } = c.body;
  if (!email || String(password || '').length < 8) fail(400, 'Enter an email and a password of at least 8 characters');
  try { db.prepare('INSERT INTO admins (name, email, password_hash, created_at) VALUES (?, ?, ?, ?)').run(name || email, email, hashPassword(password), Date.now()); }
  catch { fail(409, 'An admin with that email already exists'); }
  audit(db, c.user.email, 'admin.create', { email });
  return { ok: true };
});
r.delete('/api/admins/:id', admin, (c) => {
  if (Number(c.params.id) === c.user.id) fail(400, "You can't remove yourself");
  if (DEMO) fail(403, 'Admins cannot be removed in the demo');
  db.prepare('DELETE FROM admins WHERE id = ?').run(c.params.id);
  return { ok: true };
});
r.put('/api/account/password', admin, (c) => {
  if (DEMO) fail(403, 'The demo password cannot be changed');
  const a = db.prepare('SELECT * FROM admins WHERE id = ?').get(c.user.id);
  if (!verifyPassword(c.body.current, a.password_hash)) fail(401, 'Current password is incorrect');
  if (String(c.body.next || '').length < 8) fail(400, 'Use at least 8 characters');
  db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(hashPassword(c.body.next), a.id);
  return { ok: true };
});
r.get('/api/health', () => ({ ok: true, app: APP_NAME }));

/* ---------- server ---------- */
const PUBLIC = join(ROOT, 'public');
startServer({
  port: PORT, name: APP_NAME,
  async handler(req, res) {
    const url = req.url.split('?')[0];
    if (url.startsWith('/api/')) return r.handle(req, res, {});
    if (url.startsWith('/brand/')) { req.url = req.url.slice(6); return serveStatic(req, res, [BRAND_DIR]); }
    if (url === '/kiosk' || url === '/kiosk/') { req.url = '/kiosk.html'; }
    return serveStatic(req, res, [PUBLIC], join(PUBLIC, 'index.html'));
  }
});
export { STOP };
