import {
  html, render, useState, useEffect, useMemo, api, download, useAsync, useInterval, useNow, useRoute, go,
  Toasts, toast, errToast, Modal, Avatar, Person, applyBrand, toggleTheme, Icon, Stat, Empty, Field, Loading,
  BarChart, Donut, fmtTime, fmtDate, fmtDateTime, dur, hours, todayIn
} from './kit.js';
import { addDays, zonedTs, hhmm, parseHHMM, localMinutes } from './time.js';
import { Camera, getLocation, ACTION_LABEL, ACTION_ICON, ACTION_DONE } from './camera.js';

let META = {};
const STATUS = {
  working: ['ok', 'Working'], on_break: ['warn', 'On break'], present: ['info', 'Present'], late: ['warn', 'Late'],
  pending: ['', 'Not in yet'], absent: ['bad', 'Absent'], off: ['', 'Day off'], missing_out: ['violet', 'No clock-out']
};
const StatusBadge = ({ s }) => { const [k, l] = STATUS[s] || ['', s]; return html`<span class=${'badge ' + k}><i class="dot"></i>${l}</span>`; };
const STATE = { in: ['ok', 'In'], break: ['warn', 'On break'], out: ['', 'Out'] };
const Brand = () => html`<div class="brand"><img src=${META.logo} alt="" /><div><div class="name">${META.companyName}</div><div class="sub">${META.appName}</div></div></div>`;

/* =================== Root =================== */
function App() {
  const [session, setSession] = useState(undefined);
  const refresh = () => api('/auth/me').then((d) => setSession(d.user)).catch(() => setSession(null));
  useEffect(() => { refresh(); }, []);
  if (session === undefined) return html`<${Loading} />`;
  if (META.needsSetup) return html`<${Setup} done=${() => location.reload()} />`;
  if (!session) return html`<${Login} onDone=${refresh} />`;
  if (session.role === 'employee') return html`<${EmployeeHome} user=${session} onLogout=${refresh} />`;
  return html`<${AdminShell} user=${session} onLogout=${refresh} />`;
}

/* =================== Auth =================== */
function AuthLayout({ children }) {
  return html`<div class="auth">
    <div class="auth-art">
      <div class="row"><img src=${META.logo} style=${{ width: 40, height: 40, borderRadius: 10, background: '#fff', padding: 4 }} alt="" /><b style=${{ fontSize: 18 }}>${META.appName}</b></div>
      <div>
        <h2>${META.tagline}</h2>
        <ul>
          <li>${Icon('monitor')} Shared kiosk with personal PINs</li>
          <li>${Icon('phone')} Clock in from a phone, with location and selfie checks</li>
          <li>${Icon('clock')} Breaks, late arrivals and overtime calculated for you</li>
          <li>${Icon('file')} Timesheets and attendance reports, ready to export</li>
        </ul>
      </div>
      <div class="small" style=${{ opacity: .7 }}>${META.companyName}</div>
    </div>
    <div class="auth-form">${children}</div></div>`;
}

function Login({ onDone }) {
  const [tab, setTab] = useState('employee');
  const [f, set] = useState({ email: '', password: '', code: '', pin: '' });
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault(); setBusy(true);
    try {
      if (tab === 'admin') await api('/auth/login', { method: 'POST', body: { email: f.email, password: f.password } });
      else await api('/auth/employee', { method: 'POST', body: { code: f.code, pin: f.pin } });
      onDone();
    } catch (err) { errToast(err); } finally { setBusy(false); }
  };
  const fillDemo = (t) => { setTab(t); set(t === 'admin' ? { ...f, email: META.demo.admin.email, password: META.demo.admin.password } : { ...f, code: META.demo.employee.code, pin: META.demo.employee.pin }); };
  return html`<${AuthLayout}><form onSubmit=${submit}>
    <div class="col gap-sm"><img src=${META.logo} style=${{ width: 48, height: 48 }} alt="" /><h1>Welcome back</h1><p class="muted">Sign in to ${META.companyName}</p></div>
    <div class="seg" style=${{ alignSelf: 'flex-start' }}>
      <button type="button" class=${tab === 'employee' ? 'on' : ''} onClick=${() => setTab('employee')}>Employee</button>
      <button type="button" class=${tab === 'admin' ? 'on' : ''} onClick=${() => setTab('admin')}>Manager</button>
    </div>
    ${tab === 'admin' ? html`
      <${Field} label="Email"><input class="input" type="email" autocomplete="username" value=${f.email} onInput=${(e) => set({ ...f, email: e.target.value })} required /><//>
      <${Field} label="Password"><input class="input" type="password" autocomplete="current-password" value=${f.password} onInput=${(e) => set({ ...f, password: e.target.value })} required /><//>`
    : html`
      <${Field} label="Employee ID"><input class="input" autocomplete="username" value=${f.code} onInput=${(e) => set({ ...f, code: e.target.value })} placeholder="e.g. E101" required /><//>
      <${Field} label="PIN"><input class="input" type="password" inputmode="numeric" autocomplete="current-password" value=${f.pin} onInput=${(e) => set({ ...f, pin: e.target.value })} required /><//>`}
    <button class="btn primary lg" disabled=${busy}>${busy ? 'Signing in…' : 'Sign in'}</button>
    <a class="btn ghost" href="/kiosk">${Icon('monitor')} Open kiosk on this device</a>
    ${META.demo && html`<div class="demo-box"><b>Live demo</b>
      <span class="muted">Data is synthetic and resets regularly.</span>
      <div class="row wrap"><button type="button" class="btn sm" onClick=${() => fillDemo('admin')}>Use manager demo</button>
      <button type="button" class="btn sm" onClick=${() => fillDemo('employee')}>Use employee demo</button></div></div>`}
  </form><//>`;
}

function Setup({ done }) {
  const [f, set] = useState({ company_name: '', name: '', email: '', password: '', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  const submit = async (e) => { e.preventDefault(); try { await api('/setup', { method: 'POST', body: f }); done(); } catch (err) { errToast(err); } };
  const inp = (k, p = {}) => html`<input class="input" value=${f[k]} onInput=${(e) => set({ ...f, [k]: e.target.value })} ...${p} />`;
  return html`<${AuthLayout}><form onSubmit=${submit}>
    <h1>Set up ${META.appName}</h1><p class="muted">Create the first manager account.</p>
    <${Field} label="Company name">${inp('company_name', { required: true })}<//>
    <${Field} label="Your name">${inp('name')}<//>
    <${Field} label="Email">${inp('email', { type: 'email', required: true })}<//>
    <${Field} label="Password" help="At least 8 characters">${inp('password', { type: 'password', required: true, minlength: 8 })}<//>
    <${Field} label="Timezone">${inp('timezone')}<//>
    <button class="btn primary lg">Create account</button></form><//>`;
}

/* =================== Employee (phone) =================== */
function EmployeeHome({ onLogout }) {
  const { data, error, reload } = useAsync(() => api('/me'));
  const now = useNow(1000);
  const [busy, setBusy] = useState(false);
  const [cam, setCam] = useState(null);
  const [pinOpen, setPinOpen] = useState(false);
  useInterval(reload, 60000);
  if (error) return html`<div class="me"><${Empty} icon="alert" title=${error.message} /><button class="btn" onClick=${logout}>Sign out</button></div>`;
  if (!data) return html`<${Loading} />`;
  async function logout() { await api('/auth/logout', { method: 'POST' }); onLogout(); }
  async function act(type, photo) {
    setBusy(true);
    try {
      const loc = await getLocation();
      if (META.requireLocation && !loc) throw new Error('Location is required. Allow location access and try again.');
      const res = await api('/me/punch', { method: 'POST', body: { type, photo, ...(loc || {}) } });
      toast(`${ACTION_DONE[res.type]} at ${fmtTime(res.ts, META.timezone)}`);
      reload();
    } catch (e) { errToast(e); } finally { setBusy(false); setCam(null); }
  }
  const start = (type) => (META.requirePhoto && (type === 'in' || type === 'out')) ? setCam(type) : act(type);
  const t = data.days[0];
  const st = data.state.state;
  return html`<div class="me">
    <div class="me-head"><${Avatar} name=${data.employee.name} photo=${data.employee.photo} size="lg" />
      <div><h2>Hi, ${data.employee.name.split(' ')[0]}</h2><div class="muted small">${data.employee.title || ''}${data.employee.department ? ' · ' + data.employee.department : ''}</div></div>
      <span class="spacer"></span><button class="btn ghost icon" title="Theme" onClick=${toggleTheme}>${Icon('moon')}</button>
      <button class="btn ghost icon" title="Sign out" onClick=${logout}>${Icon('logout')}</button></div>
    <div class="card">
      <div class="clock-card">
        <div class="time">${new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: META.timezone })}</div>
        <div class="date">${new Date(now).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', timeZone: META.timezone })}</div>
        <span class=${'status-pill ' + st}><i class="dot" style=${{ width: 8, height: 8, borderRadius: '50%', background: 'currentColor' }}></i>
          ${st === 'in' ? `Clocked in since ${fmtTime(data.state.since, META.timezone)}` : st === 'break' ? `On break since ${fmtTime(data.state.since, META.timezone)}` : 'You are clocked out'}</span>
        ${cam ? html`<div style=${{ width: '100%', marginTop: 14 }}><${Camera} label=${ACTION_LABEL[cam]} onCancel=${() => setCam(null)} onCapture=${(p) => act(cam, p)} /></div>`
        : html`<div class="big-actions">${data.actions.map((a, i) => html`<button class=${'big-btn ' + (i ? 'secondary' : a)} disabled=${busy} onClick=${() => start(a)}>${Icon(ACTION_ICON[a])} ${ACTION_LABEL[a]}</button>`)}</div>`}
        ${(META.requireLocation || META.requirePhoto) && html`<div class="faint small" style=${{ marginTop: 8 }}>${META.requireLocation ? 'Your location is recorded with each punch. ' : ''}${META.requirePhoto ? 'A photo is taken when you clock in or out.' : ''}</div>`}
      </div>
      <div class="today-grid">
        <div><b>${t?.first_in ? fmtTime(t.first_in, META.timezone) : '—'}</b><span>First in</span></div>
        <div><b>${dur(t?.worked_min || 0)}</b><span>Worked today</span></div>
        <div><b>${data.schedule.start}–${data.schedule.end}</b><span>Schedule</span></div>
      </div>
    </div>
    <div class="card"><div class="card-head"><h3>Last 14 days</h3></div>
      ${data.days.filter((d) => d.status !== 'off').map((d) => html`<div class="live-row">
        <div style=${{ width: 90 }}><b class="small">${fmtDate(d.date)}</b></div>
        <div class="small muted" style=${{ flex: 1 }}>${d.first_in ? `${fmtTime(d.first_in, META.timezone)} – ${d.last_out ? fmtTime(d.last_out, META.timezone) : d.open ? 'now' : '?'}` : ''}</div>
        <b class="small">${d.worked_min ? dur(d.worked_min) : ''}</b><${StatusBadge} s=${d.status} /></div>`)}
    </div>
    <button class="btn" onClick=${() => setPinOpen(true)}>${Icon('key')} Change my PIN</button>
    ${pinOpen && html`<${ChangePin} onClose=${() => setPinOpen(false)} />`}
  </div>`;
}
function ChangePin({ onClose }) {
  const [f, set] = useState({ current: '', next: '' });
  const save = async () => { try { await api('/me/pin', { method: 'POST', body: f }); toast('PIN updated'); onClose(); } catch (e) { errToast(e); } };
  return html`<${Modal} title="Change PIN" onClose=${onClose} footer=${html`<button class="btn" onClick=${onClose}>Cancel</button><button class="btn primary" onClick=${save}>Save</button>`}>
    <${Field} label="Current PIN"><input class="input" type="password" inputmode="numeric" value=${f.current} onInput=${(e) => set({ ...f, current: e.target.value })} /><//>
    <${Field} label="New PIN" help="4–8 digits"><input class="input" type="password" inputmode="numeric" value=${f.next} onInput=${(e) => set({ ...f, next: e.target.value })} /><//><//>`;
}

/* =================== Admin shell =================== */
const NAV = [
  ['dashboard', 'Dashboard', 'home'], ['employees', 'Employees', 'users'], ['timesheets', 'Timesheets', 'clock'],
  ['reports', 'Reports', 'chart'], ['settings', 'Settings', 'settings']
];
function AdminShell({ user, onLogout }) {
  const route = useRoute();
  const page = route.parts[0] || 'dashboard';
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [route.path]);
  const logout = async () => { await api('/auth/logout', { method: 'POST' }); onLogout(); };
  const Page = { dashboard: Dashboard, employees: Employees, timesheets: Timesheets, reports: Reports, settings: Settings }[page] || Dashboard;
  const title = (NAV.find((n) => n[0] === page) || NAV[0])[1];
  return html`<div class="shell">
    <aside class=${'sidebar' + (open ? ' open' : '')}>
      <${Brand} />
      <nav class="nav">${NAV.map(([k, l, i]) => html`<a href=${'#/' + k} class=${page === k ? 'active' : ''}>${Icon(i)} ${l}</a>`)}</nav>
      <div class="nav-label">Clock-in points</div>
      <nav class="nav"><a href="/kiosk" target="_blank">${Icon('monitor')} Open kiosk</a></nav>
      <span class="spacer"></span>
      <div class="divider"></div>
      <div class="row" style=${{ padding: '8px 6px' }}><${Avatar} name=${user.name} size="sm" /><div style=${{ minWidth: 0 }}><b class="small">${user.name}</b><div class="faint small" style=${{ overflow: 'hidden', textOverflow: 'ellipsis' }}>${user.email}</div></div></div>
      <div class="row"><button class="btn ghost sm" onClick=${toggleTheme}>${Icon('moon')} Theme</button><button class="btn ghost sm" onClick=${logout}>${Icon('logout')} Sign out</button></div>
    </aside>
    ${open && html`<div class="scrim" onClick=${() => setOpen(false)}></div>`}
    <main class="main">
      <div class="topbar"><button class="btn ghost icon menu-btn" onClick=${() => setOpen(true)}>${Icon('menu')}</button><h1>${title}</h1><span class="spacer"></span>
        <span class="faint small nowrap">${new Date().toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', timeZone: META.timezone })}</span></div>
      <div class="content"><${Page} route=${route} user=${user} /></div>
    </main><//>`;
}

/* =================== Dashboard =================== */
function Dashboard() {
  const { data, reload } = useAsync(() => api('/dashboard'));
  useInterval(reload, 30000);
  const now = useNow(30000);
  if (!data) return html`<${Loading} />`;
  const s = data;
  const trend = s.trend.filter((d) => d.scheduled).map((d) => ({ label: fmtDate(d.date, { day: 'numeric', month: 'short' }), values: [{ name: 'On time', v: d.present - d.late, color: 'var(--accent)' }, { name: 'Late', v: d.late, color: '#f59e0b' }] }));
  return html`<div class="col gap-lg">
    <div class="hero-strip"><div><h2>${META.companyName}</h2><div class="muted">${s.onSite} of ${s.total} people are on site right now.</div></div>
      <span class="spacer"></span><a class="btn" href="/kiosk" target="_blank">${Icon('monitor')} Launch kiosk</a></div>
    <div class="grid grid-4">
      <${Stat} label="On site now" value=${s.onSite} hint=${`${s.counts.on_break || 0} on break`} color="var(--ok)" />
      <${Stat} label="Arrived today" value=${`${s.arrived}/${s.total}`} hint=${`${Math.round((s.arrived / Math.max(s.total, 1)) * 100)}% of the team`} color="var(--accent)" />
      <${Stat} label="Late today" value=${s.lateToday} hint="After start time plus grace" color="#f59e0b" />
      <${Stat} label="Not in yet" value=${s.notIn.length} hint="Scheduled today" color="var(--ink-3)" />
    </div>
    <div class="grid" style=${{ gridTemplateColumns: 'minmax(0,1.6fr) minmax(0,1fr)' }}>
      <div class="card"><div class="card-head"><h3>Who's in</h3><span class="pulse"></span><span class="spacer"></span><a class="small" href="#/timesheets">Timesheets →</a></div>
        ${s.live.length ? s.live.map((x) => html`<div class="live-row">
          <${Person} name=${x.name} sub=${x.department} photo=${x.photo} />
          <span class="spacer"></span>
          <span class="small muted nowrap">${fmtTime(x.first_in, META.timezone)} → ${x.open ? 'now' : fmtTime(x.last_out, META.timezone)}</span>
          <b class="small nowrap" style=${{ width: 62, textAlign: 'right' }}>${dur(x.worked_min)}</b>
          <${StatusBadge} s=${x.late && !x.open ? 'late' : x.status} /></div>`) : html`<${Empty} icon="users" title="Nobody has clocked in yet today" />`}
      </div>
      <div class="col gap-lg">
        <div class="card"><div class="card-head"><h3>Today at a glance</h3></div><div class="card-pad">
          <${Donut} center=${`${s.arrived}/${s.total}`} data=${[
            { label: 'Working', value: s.counts.working || 0, color: 'var(--ok)' }, { label: 'On break', value: s.counts.on_break || 0, color: '#f59e0b' },
            { label: 'Clocked out', value: (s.counts.present || 0) + (s.counts.late || 0), color: 'var(--accent)' }, { label: 'Not in yet', value: s.notIn.length, color: 'var(--line-strong)' }]} /></div></div>
        <div class="card"><div class="card-head"><h3>Not in yet</h3><span class="badge">${s.notIn.length}</span></div>
          <div style=${{ maxHeight: 260, overflow: 'auto' }}>${s.notIn.length ? s.notIn.map((x) => html`<div class="live-row"><${Person} name=${x.name} sub=${x.department} photo=${x.photo} /></div>`) : html`<${Empty} icon="check" title="Everyone scheduled is in" />`}</div></div>
      </div>
    </div>
    <div class="grid" style=${{ gridTemplateColumns: 'minmax(0,1.6fr) minmax(0,1fr)' }}>
      <div class="card"><div class="card-head"><h3>Attendance, last two weeks</h3><span class="spacer"></span>
        <span class="small muted row gap-sm"><i class="dot" style=${{ background: 'var(--accent)', width: 8, height: 8, borderRadius: 2, display: 'inline-block' }}></i>On time <i class="dot" style=${{ background: '#f59e0b', width: 8, height: 8, borderRadius: 2, display: 'inline-block' }}></i>Late</span></div>
        <div class="card-pad"><${BarChart} stacked data=${trend} height=${200} /></div></div>
      <div class="card"><div class="card-head"><h3>Recent activity</h3></div>
        ${s.activity.map((a) => html`<div class="live-row"><${Avatar} name=${a.name} photo=${a.photo} size="sm" />
          <div style=${{ flex: 1, minWidth: 0 }}><b class="small">${a.name}</b><div class="faint small">${ACTION_DONE[a.type]} · ${a.source}</div></div>
          <span class="small muted nowrap">${fmtDateTime(a.ts, META.timezone)}</span></div>`)}</div>
    </div>
  </div>`;
}

/* =================== Employees =================== */
function Employees() {
  const { data, reload } = useAsync(() => api('/employees'));
  const [q, setQ] = useState('');
  const [edit, setEdit] = useState(null);
  const [importing, setImporting] = useState(false);
  const list = useMemo(() => (data || []).filter((e) => !q || (e.name + e.code + (e.department || '') + (e.title || '')).toLowerCase().includes(q.toLowerCase())), [data, q]);
  if (!data) return html`<${Loading} />`;
  return html`<div class="col gap-lg">
    <div class="row wrap"><div class="search" style=${{ width: 300 }}>${Icon('search')}<input class="input" placeholder="Search people, IDs, departments" value=${q} onInput=${(e) => setQ(e.target.value)} /></div>
      <span class="spacer"></span><button class="btn" onClick=${() => setImporting(true)}>${Icon('upload')} Import CSV</button>
      <button class="btn primary" onClick=${() => setEdit({})}>${Icon('plus')} Add employee</button></div>
    <div class="card table-wrap"><table class="table"><thead><tr><th>Employee</th><th>ID</th><th>Department</th><th>Contact</th><th>Now</th><th></th></tr></thead><tbody>
      ${list.map((e) => html`<tr style=${{ opacity: e.active ? 1 : 0.5 }}>
        <td><${Person} name=${e.name} sub=${e.title} photo=${e.photo} /></td><td class="mono small">${e.code}</td><td>${e.department || '—'}</td>
        <td class="small muted">${e.email || ''}<br />${e.phone || ''}</td>
        <td>${e.active ? html`<span class=${'badge ' + STATE[e.state][0]}><i class="dot"></i>${STATE[e.state][1]}</span>` : html`<span class="badge">Inactive</span>`}</td>
        <td class="right"><button class="btn sm" onClick=${() => setEdit(e)}>${Icon('edit')} Edit</button></td></tr>`)}
    </tbody></table>${!list.length && html`<${Empty} icon="users" title="No employees match" />`}</div>
    ${edit && html`<${EmployeeForm} emp=${edit} onClose=${() => setEdit(null)} onSaved=${() => { setEdit(null); reload(); }} />`}
    ${importing && html`<${ImportCsv} onClose=${() => setImporting(false)} onDone=${() => { setImporting(false); reload(); }} />`}
  </div>`;
}

function readImage(file, max = 256) {
  return new Promise((resolve, reject) => {
    const img = new Image(); const url = URL.createObjectURL(file);
    img.onload = () => { const s = Math.min(1, max / Math.max(img.width, img.height)); const c = document.createElement('canvas'); c.width = img.width * s; c.height = img.height * s; c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url); resolve(c.toDataURL(file.type === 'image/png' ? 'image/png' : 'image/jpeg', 0.85)); };
    img.onerror = reject; img.src = url;
  });
}

function EmployeeForm({ emp, onClose, onSaved }) {
  const isNew = !emp.id;
  const [f, set] = useState({ name: '', code: '', department: '', title: '', email: '', phone: '', pin: '', active: true, ...emp, pin: '' });
  const [busy, setBusy] = useState(false);
  const inp = (k, p = {}) => html`<input class="input" value=${f[k] ?? ''} onInput=${(e) => set({ ...f, [k]: e.target.value })} ...${p} />`;
  const save = async () => {
    setBusy(true);
    try { await api(isNew ? '/employees' : '/employees/' + emp.id, { method: isNew ? 'POST' : 'PUT', body: f }); toast(isNew ? 'Employee added' : 'Saved'); onSaved(); }
    catch (e) { errToast(e); } finally { setBusy(false); }
  };
  const remove = async () => { if (!confirm(`Delete ${emp.name} and all their punches? This can't be undone.`)) return; try { await api('/employees/' + emp.id, { method: 'DELETE' }); toast('Employee deleted'); onSaved(); } catch (e) { errToast(e); } };
  return html`<${Modal} title=${isNew ? 'Add employee' : 'Edit employee'} onClose=${onClose} footer=${html`
    ${!isNew && html`<button class="btn danger" onClick=${remove}>${Icon('trash')} Delete</button>`}<span class="spacer"></span>
    <button class="btn" onClick=${onClose}>Cancel</button><button class="btn primary" disabled=${busy} onClick=${save}>${isNew ? 'Add employee' : 'Save changes'}</button>`}>
    <div class="row"><${Avatar} name=${f.name || '?'} photo=${f.photo} size="lg" />
      <label class="btn sm">${Icon('upload')} Photo<input type="file" accept="image/*" hidden onChange=${async (e) => e.target.files[0] && set({ ...f, photo: await readImage(e.target.files[0]) })} /></label>
      ${f.photo && html`<button class="btn sm ghost" onClick=${() => set({ ...f, photo: '' })}>Remove</button>`}</div>
    <div class="grid grid-2">
      <${Field} label="Full name">${inp('name', { required: true })}<//><${Field} label="Employee ID">${inp('code', { placeholder: 'E123' })}<//>
      <${Field} label="Department">${inp('department')}<//><${Field} label="Job title">${inp('title')}<//>
      <${Field} label="Email">${inp('email', { type: 'email' })}<//><${Field} label="Phone">${inp('phone')}<//>
      <${Field} label=${isNew ? 'PIN' : 'New PIN'} help=${isNew ? '4–8 digits, used on the kiosk and phone' : 'Leave blank to keep the current PIN'}>${inp('pin', { inputmode: 'numeric', maxlength: 8 })}<//>
      ${!isNew && html`<${Field} label="Status"><label class="check" style=${{ height: 38 }}><input type="checkbox" checked=${f.active} onChange=${(e) => set({ ...f, active: e.target.checked })} /> Active</label><//>`}
    </div><//>`;
}

function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; }
    else if (ch === '"') q = true; else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}
function ImportCsv({ onClose, onDone }) {
  const [text, setText] = useState('code,name,department,title,email,phone,pin\nE201,Jane Doe,Sales,Associate,jane@example.com,,4821');
  const rows = useMemo(() => { const r = parseCsv(text); if (!r.length) return []; const head = r[0].map((h) => h.trim().toLowerCase()); return r.slice(1).map((x) => Object.fromEntries(head.map((h, i) => [h, (x[i] || '').trim()]))); }, [text]);
  const go_ = async () => { try { const res = await api('/employees/import', { method: 'POST', body: { rows } }); toast(`Imported ${res.added} employees${res.skipped ? `, skipped ${res.skipped}` : ''}`); onDone(); } catch (e) { errToast(e); } };
  return html`<${Modal} wide title="Import employees from CSV" onClose=${onClose} footer=${html`<button class="btn" onClick=${onClose}>Cancel</button><button class="btn primary" onClick=${go_} disabled=${!rows.length}>Import ${rows.length} rows</button>`}>
    <p class="muted small">Paste a CSV with a header row. Columns: <span class="kbd">code</span> <span class="kbd">name</span> and optional <span class="kbd">department</span> <span class="kbd">title</span> <span class="kbd">email</span> <span class="kbd">phone</span> <span class="kbd">pin</span>. Rows with an existing ID are skipped; a random PIN is set when none is given.</p>
    <label class="btn sm" style=${{ alignSelf: 'flex-start' }}>${Icon('upload')} Choose file<input type="file" accept=".csv,text/csv" hidden onChange=${async (e) => e.target.files[0] && setText(await e.target.files[0].text())} /></label>
    <textarea class="input mono" style=${{ minHeight: 180, fontSize: 12.5 }} value=${text} onInput=${(e) => setText(e.target.value)}></textarea><//>`;
}

/* =================== Timesheets =================== */
function rangePreset(k) {
  const t = todayIn(META.timezone);
  const dow = new Date(t + 'T12:00:00Z').getUTCDay();
  return { today: [t, t], week: [addDays(t, -((dow + 6) % 7)), t], last7: [addDays(t, -6), t], month: [t.slice(0, 8) + '01', t], lastMonth: (() => { const first = t.slice(0, 8) + '01'; const lastEnd = addDays(first, -1); return [lastEnd.slice(0, 8) + '01', lastEnd]; })() }[k];
}
function RangePicker({ from, to, onChange }) {
  return html`<div class="row wrap">
    <div class="seg">${[['today', 'Today'], ['week', 'This week'], ['last7', '7 days'], ['month', 'This month'], ['lastMonth', 'Last month']].map(([k, l]) => { const [a, b] = rangePreset(k); return html`<button class=${a === from && b === to ? 'on' : ''} onClick=${() => onChange(a, b)}>${l}</button>`; })}</div>
    <input type="date" class="input sm" style=${{ width: 150 }} value=${from} onChange=${(e) => onChange(e.target.value, to)} />
    <span class="faint">to</span><input type="date" class="input sm" style=${{ width: 150 }} value=${to} onChange=${(e) => onChange(from, e.target.value)} /></div>`;
}
function Timesheets() {
  const [[from, to], setRange] = useState(rangePreset('last7'));
  const [emp, setEmp] = useState('');
  const [status, setStatus] = useState('');
  const [day, setDay] = useState(null);
  const emps = useAsync(() => api('/employees'));
  const { data, reload } = useAsync(() => api(`/timesheets?from=${from}&to=${to}${emp ? '&employee=' + emp : ''}`), [from, to, emp]);
  const rows = (data?.rows || []).filter((r) => !status || r.status === status || (status === 'late' && r.late)).sort((a, b) => b.date.localeCompare(a.date) || a.name.localeCompare(b.name));
  const total = rows.reduce((a, b) => a + b.worked_min, 0);
  return html`<div class="col gap-lg">
    <div class="row wrap"><${RangePicker} from=${from} to=${to} onChange=${(a, b) => setRange([a, b])} />
      <select class="input sm" style=${{ width: 190 }} value=${emp} onChange=${(e) => setEmp(e.target.value)}><option value="">All employees</option>${(emps.data || []).map((e) => html`<option value=${e.id}>${e.name}</option>`)}</select>
      <select class="input sm" style=${{ width: 150 }} value=${status} onChange=${(e) => setStatus(e.target.value)}><option value="">Any status</option>${Object.entries(STATUS).filter(([k]) => k !== 'off').map(([k, [, l]]) => html`<option value=${k}>${l}</option>`)}</select>
      <span class="spacer"></span><button class="btn" onClick=${() => download(`/reports/timesheet.csv?from=${from}&to=${to}${emp ? '&employee=' + emp : ''}`)}>${Icon('download')} Export CSV</button></div>
    <div class="grid grid-4">
      <${Stat} label="Rows" value=${rows.length} /><${Stat} label="Hours worked" value=${hours(total)} />
      <${Stat} label="Late arrivals" value=${rows.filter((r) => r.late).length} color="#f59e0b" /><${Stat} label="Missing clock-outs" value=${rows.filter((r) => r.missing_out).length} color="var(--violet)" />
    </div>
    <div class="card table-wrap">${!data ? html`<${Loading} />` : html`<table class="table"><thead><tr><th>Date</th><th>Employee</th><th>In</th><th>Out</th><th class="num">Break</th><th class="num">Worked</th><th class="num">Late</th><th>Status</th><th></th></tr></thead><tbody>
      ${rows.map((r) => html`<tr style=${{ cursor: 'pointer' }} onClick=${() => setDay(r)}>
        <td class="nowrap">${fmtDate(r.date)}</td><td><${Person} name=${r.name} sub=${r.department} photo=${r.photo} /></td>
        <td class="nowrap">${fmtTime(r.first_in, META.timezone)}</td><td class="nowrap">${r.open ? html`<span class="faint">now</span>` : fmtTime(r.last_out, META.timezone)}</td>
        <td class="num">${r.break_min ? dur(r.break_min) : '—'}</td><td class="num"><b>${r.worked_min ? dur(r.worked_min) : '—'}</b></td>
        <td class="num">${r.late_min ? html`<span style=${{ color: 'var(--warn)' }}>${dur(r.late_min)}</span>` : '—'}</td>
        <td><${StatusBadge} s=${r.status} /></td><td class="right">${Icon('chevronRight', { width: 16, height: 16, style: 'color:var(--ink-3)' })}</td></tr>`)}
    </tbody></table>${!rows.length && html`<${Empty} icon="clock" title="No attendance in this range" />`}`}</div>
    ${day && html`<${DayDetail} row=${day} onClose=${() => setDay(null)} onChanged=${reload} />`}
  </div>`;
}

function DayDetail({ row, onClose, onChanged }) {
  const { data, reload } = useAsync(() => api(`/punches?employee=${row.employee_id}&date=${row.date}`));
  const [adding, setAdding] = useState(null);
  const [photo, setPhoto] = useState(null);
  const tz = META.timezone;
  const toInput = (ts) => hhmm(localMinutes(ts, tz));
  const changed = () => { reload(); onChanged(); };
  const saveEdit = async (p, type, time) => { try { await api('/punches/' + p.id, { method: 'PUT', body: { type, ts: zonedTs(row.date, parseHHMM(time), tz) } }); toast('Punch updated'); changed(); } catch (e) { errToast(e); } };
  const del = async (p) => { if (!confirm('Delete this punch?')) return; try { await api('/punches/' + p.id, { method: 'DELETE' }); toast('Punch deleted'); changed(); } catch (e) { errToast(e); } };
  const add = async () => { try { await api('/punches', { method: 'POST', body: { employee_id: row.employee_id, type: adding.type, ts: zonedTs(row.date, parseHHMM(adding.time), tz), note: adding.note } }); toast('Punch added'); setAdding(null); changed(); } catch (e) { errToast(e); } };
  return html`<${Modal} wide title=${`${row.name} · ${fmtDate(row.date, { weekday: 'long', day: 'numeric', month: 'long' })}`} onClose=${onClose}>
    <div class="grid grid-4"><${Stat} label="First in" value=${fmtTime(row.first_in, tz)} /><${Stat} label="Last out" value=${row.open ? 'Now' : fmtTime(row.last_out, tz)} /><${Stat} label="Worked" value=${dur(row.worked_min)} /><${Stat} label="Break" value=${dur(row.break_min)} /></div>
    <div class="card table-wrap">${!data ? html`<${Loading} />` : html`<table class="table"><thead><tr><th>Type</th><th>Time</th><th>Source</th><th>Evidence</th><th></th></tr></thead><tbody>
      ${data.map((p) => html`<${PunchRow} key=${p.id + ':' + p.ts + p.type} p=${p} initial=${toInput(p.ts)} onSave=${saveEdit} onDelete=${del} onPhoto=${setPhoto} />`)}
    </tbody></table>${!data.length && html`<${Empty} icon="clock" title="No punches on this day" />`}`}</div>
    ${adding ? html`<div class="row wrap card card-pad">
      <select class="input sm" style=${{ width: 150 }} value=${adding.type} onChange=${(e) => setAdding({ ...adding, type: e.target.value })}>${Object.entries(ACTION_LABEL).map(([k, l]) => html`<option value=${k}>${l}</option>`)}</select>
      <input type="time" class="input sm" style=${{ width: 120 }} value=${adding.time} onInput=${(e) => setAdding({ ...adding, time: e.target.value })} />
      <input class="input sm" style=${{ flex: 1, minWidth: 160 }} placeholder="Reason (kept in the audit log)" value=${adding.note} onInput=${(e) => setAdding({ ...adding, note: e.target.value })} />
      <button class="btn sm" onClick=${() => setAdding(null)}>Cancel</button><button class="btn sm primary" onClick=${add}>Add punch</button></div>`
    : html`<button class="btn" style=${{ alignSelf: 'flex-start' }} onClick=${() => setAdding({ type: row.first_in ? 'out' : 'in', time: row.first_in ? '18:00' : '09:00', note: '' })}>${Icon('plus')} Add missing punch</button>`}
    ${photo && html`<${Modal} title="Punch photo" onClose=${() => setPhoto(null)}><img src=${photo} style=${{ width: '100%', borderRadius: 12 }} alt="Punch photo" /><//>`}
  <//>`;
}
function PunchRow({ p, initial, onSave, onDelete, onPhoto }) {
  const [type, setType] = useState(p.type); const [time, setTime] = useState(initial);
  const dirty = type !== p.type || time !== initial;
  return html`<tr>
    <td><select class="input sm" style=${{ width: 140 }} value=${type} onChange=${(e) => setType(e.target.value)}>${Object.entries(ACTION_LABEL).map(([k, l]) => html`<option value=${k}>${l}</option>`)}</select></td>
    <td><input type="time" class="input sm" style=${{ width: 110 }} value=${time} onInput=${(e) => setTime(e.target.value)} /></td>
    <td><span class="badge">${p.source}</span>${p.edited_by && html` <span class="badge violet" title=${'Edited by ' + p.edited_by}>edited</span>`}${p.note && html`<div class="faint small">${p.note}</div>`}</td>
    <td class="row gap-sm">${p.photo && html`<img class="photo-thumb" src=${p.photo} onClick=${() => onPhoto(p.photo)} alt="Punch photo" />`}
      ${p.lat != null && html`<a class="btn sm" target="_blank" rel="noopener" href=${`https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lng}#map=17/${p.lat}/${p.lng}`}>${Icon('map')} Map</a>`}
      ${!p.photo && p.lat == null && html`<span class="faint">—</span>`}</td>
    <td class="right nowrap">${dirty && html`<button class="btn sm primary" onClick=${() => onSave(p, type, time)}>Save</button> `}<button class="btn sm ghost icon" title="Delete" onClick=${() => onDelete(p)}>${Icon('trash')}</button></td></tr>`;
}

/* =================== Reports =================== */
function Reports() {
  const [[from, to], setRange] = useState(rangePreset('month'));
  const { data } = useAsync(() => api(`/reports/summary?from=${from}&to=${to}`), [from, to]);
  const [sort, setSort] = useState('name');
  if (!data) return html`<div class="col gap-lg"><${RangePicker} from=${from} to=${to} onChange=${(a, b) => setRange([a, b])} /><${Loading} /></div>`;
  const s = data.summary;
  const tot = s.reduce((a, b) => ({ present: a.present + b.present, sched: a.sched + b.scheduled_days, late: a.late + b.late, absent: a.absent + b.absent, mins: a.mins + b.worked_min, ot: a.ot + b.overtime_min }), { present: 0, sched: 0, late: 0, absent: 0, mins: 0, ot: 0 });
  const sorted = [...s].sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name) : sort === 'rate' ? (a.attendance_rate ?? 2) - (b.attendance_rate ?? 2) : sort === 'late' ? b.late - a.late : b.worked_min - a.worked_min);
  const chart = data.daily.map((d) => ({ label: fmtDate(d.date, { day: 'numeric' }), values: [{ name: 'Present', v: d.present - d.late, color: 'var(--accent)' }, { name: 'Late', v: d.late, color: '#f59e0b' }, { name: 'Absent', v: d.absent, color: 'color-mix(in srgb, var(--bad) 55%, transparent)' }] }));
  return html`<div class="col gap-lg">
    <div class="row wrap no-print"><${RangePicker} from=${from} to=${to} onChange=${(a, b) => setRange([a, b])} /><span class="spacer"></span>
      <button class="btn" onClick=${() => print()}>${Icon('print')} Print</button><button class="btn primary" onClick=${() => download(`/reports/summary?from=${from}&to=${to}&format=csv`)}>${Icon('download')} Export CSV</button></div>
    <h2>Attendance report · ${fmtDate(from, { day: 'numeric', month: 'short', year: 'numeric' })} – ${fmtDate(to, { day: 'numeric', month: 'short', year: 'numeric' })}</h2>
    <div class="grid grid-4">
      <${Stat} label="Attendance rate" value=${tot.sched ? Math.round((tot.present / tot.sched) * 100) + '%' : '—'} hint=${`${tot.present} of ${tot.sched} scheduled days`} color="var(--accent)" />
      <${Stat} label="Hours worked" value=${hours(tot.mins)} hint=${`${hours(tot.ot)} h overtime`} />
      <${Stat} label="Late arrivals" value=${tot.late} color="#f59e0b" /><${Stat} label="Absences" value=${tot.absent} color="var(--bad)" />
    </div>
    <div class="card"><div class="card-head"><h3>Daily attendance</h3></div><div class="card-pad"><${BarChart} stacked data=${chart} height=${190} /></div></div>
    <div class="card table-wrap"><div class="card-head"><h3>By employee</h3><span class="spacer"></span>
      <div class="seg no-print">${[['name', 'Name'], ['rate', 'Lowest rate'], ['late', 'Most late'], ['hours', 'Most hours']].map(([k, l]) => html`<button class=${sort === k ? 'on' : ''} onClick=${() => setSort(k)}>${l}</button>`)}</div></div>
      <table class="table"><thead><tr><th>Employee</th><th class="num">Present</th><th class="num">Absent</th><th class="num">Late</th><th class="num">Avg in</th><th class="num">Hours</th><th class="num">Overtime</th><th style=${{ width: 180 }}>Attendance</th></tr></thead><tbody>
      ${sorted.map((x) => html`<tr><td><${Person} name=${x.name} sub=${x.code + (x.department ? ' · ' + x.department : '')} photo=${x.photo} /></td>
        <td class="num">${x.present}/${x.scheduled_days}</td><td class="num">${x.absent || '—'}</td><td class="num">${x.late || '—'}</td>
        <td class="num">${hhmm(x.avg_in_min) || '—'}</td><td class="num"><b>${hours(x.worked_min)}</b></td><td class="num">${x.overtime_min ? hours(x.overtime_min) : '—'}</td>
        <td><div class="row"><div class="bar" style=${{ flex: 1 }}><i style=${{ width: Math.round((x.attendance_rate ?? 0) * 100) + '%', background: (x.attendance_rate ?? 1) < 0.85 ? 'var(--warn)' : 'var(--accent)' }}></i></div><b class="small" style=${{ width: 38, textAlign: 'right' }}>${x.attendance_rate == null ? '—' : Math.round(x.attendance_rate * 100) + '%'}</b></div></td></tr>`)}
      </tbody></table></div>
  </div>`;
}

/* =================== Settings =================== */
const TZS = (() => { try { return Intl.supportedValuesOf('timeZone'); } catch { return ['UTC', 'Asia/Dubai', 'Asia/Karachi', 'Europe/London', 'America/New_York']; } })();
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ACCENTS = ['#f97316', '#2563eb', '#16a34a', '#7c3aed', '#db2777', '#0d9488', '#dc2626', '#111827', '#bda873'];
function Settings() {
  const [tab, setTab] = useState('general');
  const { data, reload } = useAsync(() => api('/settings'));
  const [f, set] = useState(null);
  useEffect(() => { if (data) set(data); }, [data]);
  if (!f) return html`<${Loading} />`;
  const save = async (patch = f) => { try { await api('/settings', { method: 'PUT', body: patch }); toast('Settings saved'); reload(); META = await api('/meta'); applyBrand(META); } catch (e) { errToast(e); } };
  const days = new Set(f.workdays.split(',').filter(Boolean).map(Number));
  const toggleDay = (d) => { days.has(d) ? days.delete(d) : days.add(d); set({ ...f, workdays: [...days].sort().join(',') }); };
  const sw = (k, label, help) => html`<label class="check"><input type="checkbox" checked=${f[k] === '1'} onChange=${(e) => set({ ...f, [k]: e.target.checked ? '1' : '0' })} /><span><b>${label}</b><div class="faint small">${help}</div></span></label>`;
  const tabs = [['general', 'General'], ['rules', 'Clock-in rules'], ['branding', 'Branding'], ['kiosk', 'Kiosk'], ['admins', 'Managers'], ['audit', 'Audit log']];
  return html`<div style=${{ maxWidth: 860 }}>
    <div class="tabs">${tabs.map(([k, l]) => html`<button class=${tab === k ? 'on' : ''} onClick=${() => setTab(k)}>${l}</button>`)}</div>
    ${tab === 'general' && html`<div class="card card-pad col gap-lg">
      <div class="grid grid-2"><${Field} label="Company name"><input class="input" value=${f.company_name} onInput=${(e) => set({ ...f, company_name: e.target.value })} /><//>
        <${Field} label="Timezone"><select class="input" value=${f.timezone} onChange=${(e) => set({ ...f, timezone: e.target.value })}>${TZS.map((z) => html`<option>${z}</option>`)}</select><//>
        <${Field} label="Work starts"><input type="time" class="input" value=${f.work_start} onInput=${(e) => set({ ...f, work_start: e.target.value })} /><//>
        <${Field} label="Work ends"><input type="time" class="input" value=${f.work_end} onInput=${(e) => set({ ...f, work_end: e.target.value })} /><//>
        <${Field} label="Grace period (minutes)" help="Arrivals within this window are not marked late"><input type="number" min="0" max="120" class="input" value=${f.grace_minutes} onInput=${(e) => set({ ...f, grace_minutes: e.target.value })} /><//></div>
      <${Field} label="Working days"><div class="row wrap">${DAYS.map((d, i) => html`<button class=${'btn sm' + (days.has(i) ? ' primary' : '')} onClick=${() => toggleDay(i)}>${d}</button>`)}</div><//>
      <div><button class="btn primary" onClick=${() => save()}>Save changes</button></div></div>`}
    ${tab === 'rules' && html`<div class="card card-pad col gap-lg">
      ${sw('allow_mobile', 'Allow clock-in from phones', 'Employees sign in with their ID and PIN on their own device.')}
      ${sw('require_location', 'Require location on phone punches', 'The browser asks for location; the punch is rejected without it.')}
      ${sw('require_photo', 'Require a photo when clocking in or out', 'Deters buddy punching. Photos are stored with the punch and visible to managers.')}
      ${sw('allow_breaks', 'Track breaks', 'Adds Start break / End break. Break time is subtracted from hours worked.')}
      <div><button class="btn primary" onClick=${() => save()}>Save changes</button></div></div>`}
    ${tab === 'branding' && html`<div class="card card-pad col gap-lg">
      <${Field} label="Logo" help="PNG, SVG or JPG, shown in the sidebar, kiosk and sign-in screen"><div class="row"><div class="logo-preview"><img src=${f.logo || META.logo} alt="" /></div>
        <label class="btn">${Icon('upload')} Upload<input type="file" accept="image/*" hidden onChange=${async (e) => { const file = e.target.files[0]; if (!file) return; const url = file.type === 'image/svg+xml' ? await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(file); }) : await readImage(file, 400); set({ ...f, logo: url }); }} /></label>
        ${f.logo && html`<button class="btn ghost" onClick=${() => set({ ...f, logo: '' })}>Use default</button>`}</div><//>
      <${Field} label="Accent colour"><div class="row wrap">${ACCENTS.map((c) => html`<span class=${'color-swatch' + (f.accent === c ? ' on' : '')} style=${{ background: c }} onClick=${() => set({ ...f, accent: c })}></span>`)}
        <input class="input sm mono" style=${{ width: 110 }} placeholder="#hex" value=${f.accent} onInput=${(e) => set({ ...f, accent: e.target.value })} /></div><//>
      <div><button class="btn primary" onClick=${() => save()}>Save branding</button></div></div>`}
    ${tab === 'kiosk' && html`<${KioskSettings} />`}
    ${tab === 'admins' && html`<${Admins} />`}
    ${tab === 'audit' && html`<${Audit} />`}
  </div>`;
}
function KioskSettings() {
  const activate = async () => { try { await api('/kiosk/activate', { method: 'POST' }); toast('This device is now a kiosk'); } catch (e) { errToast(e); } };
  return html`<div class="card card-pad col gap-lg">
    <div><h3>Shared kiosk</h3><p class="muted">Put a tablet or PC at the entrance. Staff pick their name, enter their PIN and clock in. Activating a device stores a kiosk key in its browser, so it keeps working after you sign out.</p></div>
    <ol class="muted" style=${{ margin: 0, paddingLeft: 18, display: 'grid', gap: 6 }}><li>Sign in as a manager on the kiosk device.</li><li>Choose <b>Activate this device</b>.</li><li>Open the kiosk and switch the browser to full screen. Add it to the home screen on tablets.</li></ol>
    <div class="row wrap"><button class="btn primary" onClick=${activate}>${Icon('shield')} Activate this device</button><a class="btn" href="/kiosk" target="_blank">${Icon('monitor')} Open kiosk</a></div>
    <div class="demo-box"><b>Kiosk address</b><span class="mono">${location.origin}/kiosk</span></div></div>`;
}
function Admins() {
  const { data, reload } = useAsync(() => api('/admins'));
  const [f, set] = useState({ name: '', email: '', password: '' });
  const [pw, setPw] = useState({ current: '', next: '' });
  const add = async () => { try { await api('/admins', { method: 'POST', body: f }); toast('Manager added'); set({ name: '', email: '', password: '' }); reload(); } catch (e) { errToast(e); } };
  const del = async (a) => { if (!confirm(`Remove ${a.email}?`)) return; try { await api('/admins/' + a.id, { method: 'DELETE' }); reload(); } catch (e) { errToast(e); } };
  const change = async () => { try { await api('/account/password', { method: 'PUT', body: pw }); toast('Password changed'); setPw({ current: '', next: '' }); } catch (e) { errToast(e); } };
  return html`<div class="col gap-lg">
    <div class="card table-wrap"><table class="table"><thead><tr><th>Manager</th><th>Added</th><th></th></tr></thead><tbody>
      ${(data || []).map((a) => html`<tr><td><${Person} name=${a.name} sub=${a.email} /></td><td class="muted">${fmtDate(new Date(a.created_at).toISOString())}</td><td class="right"><button class="btn sm ghost danger" onClick=${() => del(a)}>${Icon('trash')}</button></td></tr>`)}</tbody></table></div>
    <div class="card card-pad col"><h3>Add a manager</h3><div class="grid grid-3">
      <input class="input" placeholder="Name" value=${f.name} onInput=${(e) => set({ ...f, name: e.target.value })} />
      <input class="input" placeholder="Email" type="email" value=${f.email} onInput=${(e) => set({ ...f, email: e.target.value })} />
      <input class="input" placeholder="Password (8+ chars)" type="password" value=${f.password} onInput=${(e) => set({ ...f, password: e.target.value })} /></div>
      <div><button class="btn primary" onClick=${add}>${Icon('plus')} Add manager</button></div></div>
    <div class="card card-pad col"><h3>Change my password</h3><div class="grid grid-2">
      <input class="input" type="password" placeholder="Current password" value=${pw.current} onInput=${(e) => setPw({ ...pw, current: e.target.value })} />
      <input class="input" type="password" placeholder="New password" value=${pw.next} onInput=${(e) => setPw({ ...pw, next: e.target.value })} /></div>
      <div><button class="btn" onClick=${change}>Update password</button></div></div></div>`;
}
function Audit() {
  const { data } = useAsync(() => api('/audit'));
  if (!data) return html`<${Loading} />`;
  return html`<div class="card table-wrap"><table class="table"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Detail</th></tr></thead><tbody>
    ${data.map((a) => html`<tr><td class="nowrap small">${fmtDateTime(a.ts, META.timezone)}</td><td class="small">${a.actor}</td><td><span class="badge">${a.action}</span></td><td class="mono small faint" style=${{ maxWidth: 380, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>${a.detail}</td></tr>`)}
  </tbody></table>${!data.length && html`<${Empty} icon="history" title="No changes recorded yet" />`}</div>`;
}

/* =================== Boot =================== */
(async () => {
  META = await api('/meta');
  document.title = `${META.appName} · ${META.companyName}`;
  document.querySelector('link[rel=icon]').href = META.logo;
  applyBrand(META);
  render(html`<${App} /><${Toasts} />`, document.getElementById('app'));
})();
