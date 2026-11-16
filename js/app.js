import { demoClass } from './demo.js';
import { isConfigured, deviceStatus, downloadDeviceModel, gradePaper, draftRubric, classInsights } from './ai.js';
import { privateTerms, redact } from './privacy.js';

// ---------- state (kept only in this browser) ----------
const KEY = 'redpen-v1';
const clone = (o) => JSON.parse(JSON.stringify(o));
let state = load();
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    if (s && s.students) return s;
  } catch {}
  return fresh();
}
function fresh() {
  const d = clone(demoClass);
  return { ...d, selected: d.students[0].id, feedback: {}, insights: null };
}
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {} };

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const busy = new Set();
const progress = new Map(); // id -> { where, done, total, removed }
const current = () => state.students.find((s) => s.id === state.selected) || state.students[0];

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { t.hidden = true; }, 3200);
}

// ---------- device status ----------
let status = 'unavailable';
async function refreshStatus() {
  status = await deviceStatus();
  const el = $('#ai-status');
  el.className = 'status';
  const text = $('.status-text', el);
  el.querySelector('button')?.remove();
  if (!isConfigured()) {
    el.classList.add('download');
    text.textContent = 'Setup needed: add the Firebase config';
    return;
  }
  if (status === 'available') {
    el.classList.add('device');
    text.textContent = 'Gemini Nano is on this device. Student work stays here.';
  } else if (status === 'downloadable' || status === 'downloading') {
    el.classList.add('download');
    text.textContent = status === 'downloading' ? 'Downloading the on-device model…' : 'On-device AI available. One-time download.';
    if (status === 'downloadable') {
      const b = document.createElement('button');
      b.className = 'btn small'; b.type = 'button'; b.textContent = 'Download';
      b.addEventListener('click', async () => {
        b.disabled = true; b.hidden = true;
        try {
          await downloadDeviceModel((p) => { text.textContent = `Downloading the on-device model… ${Math.round(p * 100)}%`; });
          await refreshStatus();
          toast('On-device model ready. Student work will stay on this computer.');
        } catch (e) {
          text.textContent = 'Download did not finish. Papers will be anonymized before the cloud.';
          b.disabled = false; b.hidden = false;
        }
      });
      el.append(b);
    } else {
      // Download already running (for example after a reload): check back until it finishes.
      setTimeout(refreshStatus, 5000);
    }
  } else {
    el.classList.add('cloud');
    text.textContent = 'No on-device AI here. Papers are anonymized before the cloud.';
  }
}

// ---------- tabs ----------
const tabs = $$('[role="tab"]');
function selectTab(tab) {
  for (const t of tabs) {
    const on = t === tab;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
    $('#' + t.getAttribute('aria-controls')).hidden = !on;
  }
  if (tab.id === 'tab-insights') renderScoreGrid();
}
tabs.forEach((t, i) => {
  t.addEventListener('click', () => selectTab(t));
  t.addEventListener('keydown', (e) => {
    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!d) return;
    const n = tabs[(i + d + tabs.length) % tabs.length];
    selectTab(n); n.focus();
  });
});

// ---------- roster ----------
function avgScore(fb) {
  if (!fb?.criteria?.length) return null;
  return (fb.criteria.reduce((a, c) => a + (+c.score || 0), 0) / fb.criteria.length).toFixed(1);
}
function renderRoster() {
  const ul = $('#roster-list');
  ul.innerHTML = '';
  for (const s of state.students) {
    const fb = state.feedback[s.id]?.feedback;
    const li = document.createElement('li');
    const avg = avgScore(fb);
    const st = busy.has(s.id) ? 'busy' : fb ? 'done' : '';
    li.innerHTML = `<button type="button" ${s.id === state.selected ? 'aria-current="true"' : ''}>
      <span class="st-name">${escapeHtml(s.name)}</span>
      ${avg ? `<span class="avg" aria-label="average ${avg} out of 4">${avg}</span>` : '<span></span>'}
      <span class="st-meta"><span class="pip ${st}"></span>${busy.has(s.id) ? busyLabel(s.id) : fb ? (state.feedback[s.id].route.where === 'device' ? 'Done · on device' : 'Done · anonymized') : 'Not graded'}</span>
    </button>`;
    li.querySelector('button').addEventListener('click', () => { state.selected = s.id; save(); renderAll(); });
    ul.append(li);
  }
}

// ---------- paper ----------
function renderPaper() {
  const s = current();
  $('#paper-name').textContent = s.name;
  $('#paper-words').textContent = `${s.essay.trim().split(/\s+/).length} words`;
  let html = escapeHtml(s.essay);
  const fb = state.feedback[s.id]?.feedback;
  if (fb) {
    fb.criteria.forEach((c, i) => {
      const q = (c.evidence || '').replace(/^["“']|["”']$/g, '').trim();
      if (q.length < 4) return;
      const qe = escapeHtml(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
      const re = new RegExp(qe, 'i');
      html = html.replace(re, (m) => `<mark>${m}<sup>${i + 1}</sup></mark>`);
    });
  }
  $('#paper').innerHTML = html;
}

// ---------- feedback ----------
const ICON_DEVICE = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/><path d="M9 10l2 2 4-4"/></svg>';
const ICON_CLOUD = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 18a4 4 0 0 1-.5-8A6 6 0 0 1 18 9a4.5 4.5 0 0 1-1 9H7Z"/><path d="M12 10v5M9.5 12.5 12 10l2.5 2.5"/></svg>';

function receipt(route) {
  if (route.where === 'device') {
    return `<div class="receipt device">${ICON_DEVICE}<b>Stayed on this device</b><span>Drafted by Gemini Nano in Chrome. 0 bytes sent. ${duration(route.ms)}.</span></div>`;
  }
  const kinds = {};
  for (const r of route.removed) kinds[r.type] = (kinds[r.type] || 0) + 1;
  const label = { STUDENT: 'student name', CLASSMATE: 'classmate', TEACHER: 'teacher', SCHOOL: 'school', EMAIL: 'email', PHONE: 'phone', ID: 'ID number', ADDRESS: 'address', DATE: 'date', LINK: 'link', PRIVATE: 'private word' };
  const chips = Object.entries(kinds).map(([k, n]) => `<span>${n} × ${label[k] || k.toLowerCase()}</span>`).join('');
  const sent = escapeHtml(route.sentText || '').replace(/\[[A-Z_0-9]+\]/g, (m) => `<span class="ph">${m}</span>`);
  return `<div class="receipt cloud">${ICON_CLOUD}<b>Anonymized here, then sent</b><span>${route.removed.length} private detail${route.removed.length === 1 ? '' : 's'} removed on this device before anything left it. ${escapeHtml(route.reason || '')}.</span>
    <details><summary>See exactly what the cloud received</summary>
      ${chips ? `<div class="removed">${chips}</div>` : ''}
      <div class="sent">${sent}</div>
    </details></div>`;
}

function renderFeedback() {
  const s = current();
  const body = $('#feedback-body');
  if (busy.has(s.id)) {
    const p = progress.get(s.id);
    let msg = '';
    if (p?.where === 'device') {
      msg = `<div class="drafting device"><b>Drafting on this device</b><span>${p.done} of ${p.total} criteria scored. Nothing is being sent.</span><div class="bar"><i style="width:${Math.round((p.done / p.total) * 100)}%"></i></div></div>`;
    } else if (p?.where === 'cloud') {
      msg = `<div class="drafting cloud"><b>Anonymized, now drafting in the cloud</b><span>${p.removed} private detail${p.removed === 1 ? '' : 's'} removed before sending.</span></div>`;
    }
    body.innerHTML = `${msg}<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>`;
    return;
  }
  const entry = state.feedback[s.id];
  if (entry?.error) {
    body.innerHTML = `<div class="err">${escapeHtml(entry.error)}</div>`;
    return;
  }
  if (!entry) {
    body.innerHTML = `<div class="empty">Draft rubric scores, comments and a note to ${escapeHtml(s.name.split(' ')[0])}.<br>You review and edit everything before it goes anywhere.</div>`;
    return;
  }
  const fb = entry.feedback;
  body.innerHTML = `${receipt(entry.route)}
    ${fb.criteria.map((c, i) => `<div class="crit" data-i="${i}">
      <div class="crit-top"><h3>${escapeHtml(c.name)}</h3>
        <div class="score" role="group" aria-label="${escapeHtml(c.name)} score">${[1, 2, 3, 4].map((n) => `<button type="button" aria-pressed="${+c.score === n}" aria-label="${n} of 4">${n}</button>`).join('')}</div>
      </div>
      ${c.evidence ? `<p class="evidence"><sup>${i + 1}</sup> “${escapeHtml(c.evidence)}”</p>` : ''}
      <div class="edit" contenteditable="true" data-field="comment" aria-label="${escapeHtml(c.name)} comment">${escapeHtml(c.comment)}</div>
    </div>`).join('')}
    <div class="gg">
      <div class="glow"><h4>Glow</h4><div class="edit" contenteditable="true" data-top="glow" aria-label="Strength">${escapeHtml(fb.glow)}</div></div>
      <div class="grow"><h4>Grow</h4><div class="edit" contenteditable="true" data-top="grow" aria-label="Next step">${escapeHtml(fb.grow)}</div></div>
    </div>
    <div class="note"><h4>Note to ${escapeHtml(s.name.split(' ')[0])}</h4><div class="edit" contenteditable="true" data-top="studentNote" aria-label="Note to student">${escapeHtml(fb.studentNote)}</div></div>
    <div class="actions">
      <button class="btn small" type="button" id="copy-fb">Copy feedback</button>
      <button class="btn small ghost" type="button" id="redo-fb">Redo</button>
    </div>`;

  $$('.crit', body).forEach((el) => {
    const i = +el.dataset.i;
    $$('.score button', el).forEach((b, k) => b.addEventListener('click', () => {
      fb.criteria[i].score = k + 1; save(); renderFeedback(); renderRoster();
    }));
    $('[data-field="comment"]', el).addEventListener('input', (e) => { fb.criteria[i].comment = e.target.innerText; save(); });
  });
  $$('[data-top]', body).forEach((el) => el.addEventListener('input', () => { fb[el.dataset.top] = el.innerText; save(); }));
  $('#copy-fb').addEventListener('click', async () => {
    const txt = `${fb.criteria.map((c) => `${c.name}: ${c.score}/4. ${c.comment}`).join('\n')}\n\nGlow: ${fb.glow}\nGrow: ${fb.grow}\n\n${fb.studentNote}`;
    try { await navigator.clipboard.writeText(txt); toast('Feedback copied. Paste it into your gradebook or LMS.'); } catch { toast('Copy failed. Select the text instead.'); }
  });
  $('#redo-fb').addEventListener('click', () => gradeOne(s.id));
}

const route = () => $('input[name="route"]:checked').value;

function duration(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

function busyLabel(id) {
  const p = progress.get(id);
  if (p?.where === 'device') return `On device · ${p.done}/${p.total}`;
  if (p?.where === 'cloud') return 'Anonymized · drafting';
  return 'Drafting…';
}

async function gradeOne(id) {
  const s = state.students.find((x) => x.id === id);
  if (!s || busy.has(id)) return;
  busy.add(id); renderRoster(); if (id === state.selected) renderFeedback();
  try {
    const result = await gradePaper({
      student: s, roster: state.students, settings: state.settings,
      assignment: state.assignment, rubric: state.rubric, essay: s.essay,
      forceCloud: route() === 'cloud',
      onProgress: (p) => {
        progress.set(id, p);
        renderRoster();
        if (id === state.selected) renderFeedback();
      },
    });
    // keep rubric names consistent even if the model rephrases them
    result.feedback.criteria = state.rubric.map((r, i) => ({ ...(result.feedback.criteria[i] || {}), name: r.name, score: Math.min(4, Math.max(1, +(result.feedback.criteria[i]?.score) || 1)) }));
    state.feedback[id] = result;
  } catch (e) {
    console.error(e);
    state.feedback[id] = { error: friendlyError(e) };
  } finally {
    busy.delete(id); progress.delete(id); save();
    renderRoster();
    if (id === state.selected) { renderPaper(); renderFeedback(); }
  }
}

function friendlyError(e) {
  const m = String(e?.message || e);
  if (/not configured/i.test(m)) return 'Red Pen is not connected to Firebase yet.';
  if (/on-device|LanguageModel|unavailable/i.test(m)) return 'The on-device model could not run here. Switch the route to "Anonymized cloud" and try again.';
  if (!navigator.onLine) return 'You are offline and this device has no on-device model, so this paper will be drafted when you reconnect.';
  return `Something went wrong drafting feedback: ${m}`;
}

$('#grade-one').addEventListener('click', () => gradeOne(state.selected));
$('#grade-all').addEventListener('click', async () => {
  const todo = state.students.filter((s) => !state.feedback[s.id]?.feedback);
  if (!todo.length) { toast('Every paper already has feedback.'); return; }
  for (const s of todo) await gradeOne(s.id);
  toast(`Drafted feedback for ${todo.length} paper${todo.length === 1 ? '' : 's'}.`);
});

$('#add-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const s = { id: 's' + Date.now(), name: f.get('name').trim(), aliases: [], essay: f.get('essay').trim() };
  state.students.push(s); state.selected = s.id; save();
  e.target.reset(); e.target.closest('details').open = false;
  renderAll();
});

// ---------- rubric tab ----------
function renderRubric() {
  $('#assignment').value = state.assignment;
  const ol = $('#rubric-list');
  ol.innerHTML = '';
  state.rubric.forEach((c, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<div class="rrow">
      <input aria-label="Criterion ${i + 1} name" value="${escapeHtml(c.name)}">
      <input aria-label="Criterion ${i + 1} description" value="${escapeHtml(c.description)}">
      <button class="btn small ghost" type="button" aria-label="Remove ${escapeHtml(c.name)}">Remove</button>
    </div>`;
    const [n, d] = $$('input', li);
    n.addEventListener('input', () => { c.name = n.value; save(); });
    d.addEventListener('input', () => { c.description = d.value; save(); });
    $('button', li).addEventListener('click', () => { state.rubric.splice(i, 1); save(); renderRubric(); });
    ol.append(li);
  });
}
$('#assignment').addEventListener('input', (e) => { state.assignment = e.target.value; save(); });
$('#add-criterion').addEventListener('click', () => { state.rubric.push({ name: 'New criterion', description: 'What a 4 looks like.' }); save(); renderRubric(); });
$('#draft-rubric').addEventListener('click', async (e) => {
  const b = e.currentTarget; b.disabled = true; b.textContent = 'Drafting…';
  try {
    const { rubric, source } = await draftRubric(state.assignment, state.settings.readingLevel || 9);
    state.rubric = rubric.slice(0, 6); save(); renderRubric();
    setSrc($('#rubric-src'), source);
  } catch (err) { toast(friendlyError(err)); }
  b.disabled = false; b.textContent = 'Draft a rubric from this prompt';
});
function setSrc(el, source) {
  const dev = source === 'on_device';
  el.className = 'src ' + (dev ? 'device' : 'cloud');
  el.textContent = dev ? 'Made on this device (offline fallback)' : 'Made in the cloud · no student data used';
}

// ---------- insights tab ----------
function renderScoreGrid() {
  const graded = state.students.filter((s) => state.feedback[s.id]?.feedback);
  const box = $('#score-grid');
  if (!graded.length) { box.innerHTML = '<p class="hint">Draft feedback for a few papers first.</p>'; return; }
  box.innerHTML = `<table><thead><tr><th>Student</th>${state.rubric.map((r) => `<th>${escapeHtml(r.name)}</th>`).join('')}</tr></thead><tbody>
    ${graded.map((s) => `<tr><td>${escapeHtml(s.name)}</td>${state.feedback[s.id].feedback.criteria.map((c) => `<td class="s${c.score}">${c.score}</td>`).join('')}</tr>`).join('')}
  </tbody></table>`;
  if (state.insights) renderInsights();
}
$('#build-insights').addEventListener('click', async (e) => {
  const graded = state.students.filter((s) => state.feedback[s.id]?.feedback);
  if (graded.length < 2) { toast('Draft feedback for at least two papers first.'); return; }
  const b = e.currentTarget; b.disabled = true; b.textContent = 'Building…';
  try {
    const rows = graded.map((s) => ({
      scores: state.feedback[s.id].feedback.criteria.map((c) => c.score),
      grow: redact(state.feedback[s.id].feedback.grow, privateTerms(s, state.students, state.settings)).text,
    }));
    const res = await classInsights({ assignment: state.assignment, rubric: state.rubric, rows, gradeLevel: state.settings.readingLevel || 9 });
    state.insights = res; save(); renderInsights();
  } catch (err) { toast(friendlyError(err)); }
  b.disabled = false; b.textContent = 'Build class insights';
});
function renderInsights() {
  const { insights: x, source, sentText } = state.insights;
  setSrc($('#insights-src'), source);
  $('#insights-body').innerHTML = `<div class="ins-grid">
    <div class="card"><h2>Patterns</h2>${x.patterns.map((p) => `<div class="pattern"><span class="n">${p.students}</span><b>${escapeHtml(p.issue)}</b><span class="hint">${escapeHtml(p.why)}</span></div>`).join('')}</div>
    <div class="card lesson"><h2>${escapeHtml(x.miniLesson.title)}</h2><p class="hint">${x.miniLesson.minutes}-minute mini-lesson</p><ol>${x.miniLesson.steps.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ol></div>
  </div>
  <div class="card"><h2>Practice, three ways</h2><div class="tiers">
    <div><h4>Approaching</h4>${escapeHtml(x.practice.approaching)}</div>
    <div><h4>On level</h4>${escapeHtml(x.practice.onLevel)}</div>
    <div><h4>Advanced</h4>${escapeHtml(x.practice.advanced)}</div>
  </div>
  <details class="mt"><summary class="hint">What this was built from</summary><div class="sent">${escapeHtml(sentText)}</div></details></div>`;
}

// ---------- settings ----------
const dlg = $('#settings');
$('#open-settings').addEventListener('click', () => {
  const f = $('#settings-form');
  for (const [k, v] of Object.entries(state.settings)) if (f.elements[k]) f.elements[k].value = v;
  dlg.showModal();
});
$('#settings-form').addEventListener('submit', () => {
  const f = $('#settings-form');
  for (const k of ['className', 'teacher', 'school', 'extraTerms', 'tone', 'readingLevel']) state.settings[k] = f.elements[k].value;
  save(); renderAll();
});
$('#reset-demo').addEventListener('click', () => { state = fresh(); save(); dlg.close(); renderAll(); toast('Demo class restored.'); });
$('#clear-all').addEventListener('click', () => {
  if (!confirm('Delete every paper and all feedback from this browser? This cannot be undone.')) return;
  state.students = []; state.feedback = {}; state.insights = null; save(); dlg.close(); renderAll();
});

// ---------- network ----------
function net() { $('#net').hidden = navigator.onLine; }
addEventListener('online', net); addEventListener('offline', net);

// ---------- boot ----------
function renderAll() {
  $('#class-name').textContent = state.settings.className || 'My class';
  if (!state.students.length) {
    $('#roster-list').innerHTML = '<li class="hint">No papers yet. Add one below.</li>';
    $('#paper-name').textContent = 'No paper selected';
    $('#paper').textContent = '';
    $('#feedback-body').innerHTML = '';
  } else {
    renderRoster(); renderPaper(); renderFeedback();
  }
  renderRubric();
}
renderAll(); net(); refreshStatus();
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
