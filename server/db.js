import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { localDate, localMinutes, parseHHMM, weekday, dateRange } from './lib/time.js';

export const DEFAULT_SETTINGS = {
  company_name: 'Northwind Retail',
  timezone: 'Asia/Dubai',
  work_start: '09:00',
  work_end: '18:00',
  grace_minutes: '10',
  workdays: '1,2,3,4,5,6',        // 0 = Sunday … 6 = Saturday
  require_photo: '0',
  require_location: '0',
  allow_mobile: '1',
  allow_breaks: '1',
  accent: '',
  logo: ''
};

export function openDb(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS employees (
      id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
      email TEXT, phone TEXT, department TEXT, title TEXT, pin_hash TEXT NOT NULL,
      photo TEXT, active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS punches (
      id INTEGER PRIMARY KEY, employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN ('in','out','break_start','break_end')),
      ts INTEGER NOT NULL, source TEXT NOT NULL DEFAULT 'kiosk', lat REAL, lng REAL, accuracy REAL,
      photo TEXT, note TEXT, edited_by TEXT, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS punches_emp_ts ON punches(employee_id, ts);
    CREATE INDEX IF NOT EXISTS punches_ts ON punches(ts);
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, actor TEXT, action TEXT NOT NULL, detail TEXT);
  `);
  return db;
}

export function getSettings(db) {
  const out = { ...DEFAULT_SETTINGS };
  for (const r of db.prepare('SELECT key, value FROM settings').all()) out[r.key] = r.value;
  return out;
}
export function setSettings(db, patch) {
  const st = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of Object.entries(patch)) if (k in DEFAULT_SETTINGS) st.run(k, String(v ?? ''));
}
export function audit(db, actor, action, detail) {
  db.prepare('INSERT INTO audit (ts, actor, action, detail) VALUES (?, ?, ?, ?)').run(Date.now(), actor, action, detail ? JSON.stringify(detail) : null);
}

/** Current state of an employee from their latest punch. */
export function currentState(db, employeeId) {
  const last = db.prepare('SELECT type, ts FROM punches WHERE employee_id = ? ORDER BY ts DESC, id DESC LIMIT 1').get(employeeId);
  if (!last || last.type === 'out') return { state: 'out', since: last?.ts ?? null };
  if (last.type === 'break_start') return { state: 'break', since: last.ts };
  return { state: 'in', since: last.ts };
}

export function allowedActions(state, allowBreaks) {
  if (state === 'out') return ['in'];
  if (state === 'break') return ['break_end'];
  return allowBreaks ? ['out', 'break_start'] : ['out'];
}

/**
 * Builds one row per (employee, local date) from punches.
 * Worked time = sum of in→out spans minus breaks. Open spans count up to `now` only for today.
 */
export function buildDays(db, settings, { from, to, employeeIds, now = Date.now() }) {
  const tz = settings.timezone;
  const start = parseHHMM(settings.work_start);
  const end = parseHHMM(settings.work_end);
  const grace = Number(settings.grace_minutes) || 0;
  const workdays = new Set(String(settings.workdays).split(',').filter(Boolean).map(Number));
  const today = localDate(now, tz);

  const emps = db.prepare(`SELECT id, code, name, department, title, photo, active, created_at FROM employees ${employeeIds ? `WHERE id IN (${employeeIds.map(Number).join(',') || 0})` : ''} ORDER BY name`).all();
  // Query a day of padding on each side for timezone edges.
  const fromTs = Date.parse(from + 'T00:00:00Z') - 864e5;
  const toTs = Date.parse(to + 'T23:59:59Z') + 864e5;
  const punches = db.prepare('SELECT id, employee_id, type, ts, source, note, photo IS NOT NULL AS has_photo, lat, lng FROM punches WHERE ts BETWEEN ? AND ? ORDER BY ts, id').all(fromTs, toTs);

  const byKey = new Map();
  for (const p of punches) {
    const d = localDate(p.ts, tz);
    if (d < from || d > to) continue;
    const k = p.employee_id + '|' + d;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(p);
  }

  const rows = [];
  for (const e of emps) {
    const joined = localDate(e.created_at, tz);
    for (const date of dateRange(from, to)) {
      if (date > today) continue;
      const list = byKey.get(e.id + '|' + date) || [];
      const scheduled = workdays.has(weekday(date));
      const r = summarizeDay(list, { date, tz, start, end, grace, scheduled, isToday: date === today, now });
      if (!list.length && (date < joined || !e.active)) continue;
      rows.push({ employee_id: e.id, code: e.code, name: e.name, department: e.department, photo: e.photo, date, ...r });
    }
  }
  return rows;
}

export function summarizeDay(list, { tz, start, end, grace, scheduled, isToday, now }) {
  let worked = 0, breaks = 0, openIn = null, openBreak = null, firstIn = null, lastOut = null, missingOut = false;
  for (const p of list) {
    if (p.type === 'in') { if (openIn == null) openIn = p.ts; if (firstIn == null) firstIn = p.ts; }
    else if (p.type === 'out') { if (openIn != null) { worked += p.ts - openIn; openIn = null; } if (openBreak != null) { breaks += p.ts - openBreak; openBreak = null; } lastOut = p.ts; }
    else if (p.type === 'break_start') { if (openBreak == null) openBreak = p.ts; }
    else if (p.type === 'break_end') { if (openBreak != null) { breaks += p.ts - openBreak; openBreak = null; } }
  }
  let open = false;
  if (openIn != null) {
    if (isToday) { worked += now - openIn; open = true; if (openBreak != null) breaks += now - openBreak; }
    else missingOut = true;
  }
  const workedMin = Math.max(0, Math.round((worked - breaks) / 60000));
  const breakMin = Math.round(breaks / 60000);
  const inMin = firstIn != null ? localMinutes(firstIn, tz) : null;
  const outMin = lastOut != null && !open ? localMinutes(lastOut, tz) : null;
  const lateMin = scheduled && inMin != null && inMin > start + grace ? inMin - start : 0;
  const earlyMin = scheduled && outMin != null && outMin < end ? end - outMin : 0;
  const scheduledMin = Math.max(0, end - start);
  const overtimeMin = scheduled ? Math.max(0, workedMin - scheduledMin) : workedMin;
  let status;
  if (!list.length) status = scheduled ? (isToday ? 'pending' : 'absent') : 'off';
  else if (open) status = openBreak != null ? 'on_break' : 'working';
  else if (missingOut) status = 'missing_out';
  else status = lateMin ? 'late' : 'present';
  return {
    first_in: firstIn, first_in_min: inMin, last_out: open ? null : lastOut, worked_min: workedMin, break_min: breakMin,
    late_min: lateMin, early_min: earlyMin, overtime_min: overtimeMin, scheduled, status, open, missing_out: missingOut,
    punches: list.length, late: lateMin > 0
  };
}

export function summarize(rows) {
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.employee_id)) by.set(r.employee_id, { employee_id: r.employee_id, code: r.code, name: r.name, department: r.department, photo: r.photo, present: 0, late: 0, absent: 0, missing_out: 0, worked_min: 0, overtime_min: 0, late_min: 0, scheduled_days: 0, in_sum: 0, in_n: 0 });
    const s = by.get(r.employee_id);
    if (r.scheduled) s.scheduled_days++;
    if (['present', 'late', 'working', 'on_break', 'missing_out'].includes(r.status)) s.present++;
    if (r.late) s.late++;
    if (r.status === 'absent') s.absent++;
    if (r.missing_out) s.missing_out++;
    s.worked_min += r.worked_min; s.overtime_min += r.overtime_min; s.late_min += r.late_min;
    if (r.first_in_min != null) { s.in_sum += r.first_in_min; s.in_n++; }
  }
  return [...by.values()].map((s) => ({ ...s, attendance_rate: s.scheduled_days ? Math.min(1, s.present / s.scheduled_days) : null, avg_in_min: s.in_n ? Math.round(s.in_sum / s.in_n) : null }));
}
