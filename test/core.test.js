import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, summarizeDay, buildDays, getSettings, allowedActions, currentState } from '../server/db.js';
import { zonedTs } from '../server/lib/time.js';
import { hashPassword, verifyPassword, toCsv } from '../server/lib/http.js';

const tz = 'Asia/Dubai';
const at = (date, hm) => zonedTs(date, Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3)), tz);

test('day summary subtracts breaks and applies grace', () => {
  const d = '2026-03-02';
  const r = summarizeDay([{ type: 'in', ts: at(d, '09:08') }, { type: 'break_start', ts: at(d, '13:00') }, { type: 'break_end', ts: at(d, '13:30') }, { type: 'out', ts: at(d, '18:00') }],
    { tz, start: 540, end: 1080, grace: 10, scheduled: true, isToday: false, now: Date.now() });
  assert.equal(r.worked_min, 8 * 60 + 52 - 30);
  assert.equal(r.late_min, 0);
  assert.equal(r.status, 'present');
});

test('next allowed action follows the current state', () => {
  assert.deepEqual(allowedActions('out', true), ['in']);
  assert.deepEqual(allowedActions('in', true), ['out', 'break_start']);
  assert.deepEqual(allowedActions('in', false), ['out']);
  assert.deepEqual(allowedActions('break', true), ['break_end']);
});

test('buildDays marks absences on scheduled days only', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO employees (code, name, pin_hash, created_at) VALUES ('E1', 'Test', 'x', 0)").run();
  db.prepare("INSERT INTO punches (employee_id, type, ts, created_at) VALUES (1, 'in', ?, 0)").run(at('2026-03-02', '09:30'));
  const rows = buildDays(db, getSettings(db), { from: '2026-03-01', to: '2026-03-03' });
  assert.deepEqual(rows.map((r) => r.status), ['off', 'missing_out', 'absent']);
  assert.equal(currentState(db, 1).state, 'in');
});

test('PIN hashing round-trips and CSV neutralises formulas', () => {
  const h = hashPassword('1234');
  assert.ok(verifyPassword('1234', h));
  assert.ok(!verifyPassword('4321', h));
  assert.match(toCsv([{ a: '=SUM(A1)' }], [{ label: 'A', key: 'a' }]), /"'=SUM\(A1\)"/);
});
