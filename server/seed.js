// Demo data: realistic staff and ~5 weeks of punch history. Synthetic names only.
import { hashPassword } from './lib/http.js';
import { localDate, zonedTs, addDays, weekday, parseHHMM } from './lib/time.js';
import { getSettings, setSettings } from './db.js';

const PEOPLE = [
  ['Aisha Rahman', 'Operations', 'Shift Supervisor'], ['Omar Khalid', 'Warehouse', 'Stock Controller'],
  ['Priya Nair', 'Front Desk', 'Receptionist'], ['Daniel Brooks', 'Sales', 'Sales Associate'],
  ['Fatima Zahra', 'Finance', 'Accountant'], ['Rohan Mehta', 'Warehouse', 'Forklift Operator'],
  ['Maria Santos', 'Operations', 'Cashier'], ['Yusuf Hamdan', 'Field Service', 'Technician'],
  ['Hannah Clarke', 'Sales', 'Store Manager'], ['Bilal Ahmed', 'Warehouse', 'Picker'],
  ['Grace Mwangi', 'Operations', 'Cashier'], ['Arjun Das', 'Field Service', 'Electrician'],
  ['Layla Hassan', 'Front Desk', 'Customer Care'], ['Kenji Tanaka', 'Sales', 'Visual Merchandiser'],
  ['Sara Iqbal', 'Finance', 'Payroll Officer'], ['Joseph Mensah', 'Warehouse', 'Driver'],
  ['Noor Al Amiri', 'Operations', 'Team Lead'], ['Carlos Rivera', 'Field Service', 'HVAC Technician'],
  ['Ayesha Siddiqui', 'Sales', 'Sales Associate'], ['Tom Becker', 'Warehouse', 'Loader'],
  ['Mei Lin', 'Operations', 'Barista'], ['Hamza Qureshi', 'Field Service', 'Plumber'],
  ['Elena Petrova', 'Front Desk', 'Office Admin'], ['Samuel Okafor', 'Sales', 'Sales Associate']
];

const CONSTRUCTION = { 'Operations': ['Site Execution', 'Site Engineer'], 'Warehouse': ['Joinery Workshop', 'Carpenter'], 'Front Desk': ['Admin & Reception', 'Office Coordinator'],
  'Sales': ['Design Studio', 'Interior Designer'], 'Finance': ['Finance', 'Accountant'], 'Field Service': ['MEP', 'Electrician'] };
const profile = () => (process.env.DEMO_PROFILE === 'construction' ? CONSTRUCTION : null);

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

export function seedDemo(db, { brandName } = {}) {
  const now = Date.now();
  const rand = rng(20261121);
  setSettings(db, { company_name: brandName || 'Northwind Retail', allow_breaks: '1', ...(process.env.DEMO_TIMEZONE ? { timezone: process.env.DEMO_TIMEZONE } : {}) });
  const settings = getSettings(db);
  const tz = settings.timezone;
  db.prepare('INSERT OR IGNORE INTO admins (name, email, password_hash, created_at) VALUES (?, ?, ?, ?)')
    .run('Demo Admin', 'admin@demo.local', hashPassword('demo1234'), now);

  const pin = hashPassword('1234');
  const insE = db.prepare('INSERT INTO employees (code, name, email, phone, department, title, pin_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const ids = PEOPLE.map(([name, dept, title], i) => {
    if (profile()?.[dept]) { title = i % 3 ? profile()[dept][1] : title; dept = profile()[dept][0]; }
    const code = 'E' + String(101 + i);
    const email = name.toLowerCase().replace(/[^a-z]+/g, '.') + '@example.com';
    return Number(insE.run(code, name, email, '+000 0000 ' + String(1000 + i), dept, title, pin, now - 60 * 864e5).lastInsertRowid);
  });

  const insP = db.prepare('INSERT INTO punches (employee_id, type, ts, source, lat, lng, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const today = localDate(now, tz);
  const start = parseHHMM(settings.work_start), end = parseHHMM(settings.work_end);
  const workdays = new Set(settings.workdays.split(',').map(Number));
  db.exec('BEGIN');
  for (let back = 35; back >= 0; back--) {
    const date = addDays(today, -back);
    if (!workdays.has(weekday(date))) continue;
    ids.forEach((id, idx) => {
      const r = rand();
      const reliability = idx % 7 === 3 ? 0.82 : 0.95; // a few people are absent more often
      if (r > reliability) return;
      const lateProne = idx % 5 === 1;
      const arrive = start - 20 + Math.floor(rand() * 32) + (lateProne && rand() < 0.45 ? 15 + Math.floor(rand() * 35) : 0);
      const leave = end - 10 + Math.floor(rand() * 70);
      const src = rand() < 0.7 ? 'kiosk' : 'mobile';
      const geo = src === 'mobile' ? [25.2048 + rand() * 0.01, 55.2708 + rand() * 0.01] : [null, null];
      const t = (m) => zonedTs(date, m, tz);
      if (back === 0) {
        const nowMin = Math.floor((now - zonedTs(date, 0, tz)) / 60000);
        if (arrive > nowMin) return; // not arrived yet
        insP.run(id, 'in', t(arrive), src, ...geo, now);
        const bs = 13 * 60 + Math.floor(rand() * 40);
        if (nowMin > bs && rand() < 0.6) {
          insP.run(id, 'break_start', t(bs), src, ...geo, now);
          const be = bs + 30 + Math.floor(rand() * 20);
          if (nowMin > be) insP.run(id, 'break_end', t(be), src, ...geo, now);
        }
        if (nowMin > leave) insP.run(id, 'out', t(leave), src, ...geo, now);
        return;
      }
      insP.run(id, 'in', t(arrive), src, ...geo, now);
      if (rand() < 0.7) {
        const bs = 12 * 60 + 45 + Math.floor(rand() * 60);
        insP.run(id, 'break_start', t(bs), src, ...geo, now);
        insP.run(id, 'break_end', t(bs + 30 + Math.floor(rand() * 25)), src, ...geo, now);
      }
      if (rand() < 0.03) return; // forgot to clock out
      insP.run(id, 'out', t(leave), src, ...geo, now);
    });
  }
  db.exec('COMMIT');
}
