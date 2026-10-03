const actionToken = document.querySelector('meta[name="tutor-action-token"]').content;
const apiBase = document.querySelector('meta[name="tutor-api-base"]')?.content || '/api';
const actionHeader = document.querySelector('meta[name="tutor-action-header"]')?.content || 'x-tutor-action-token';
const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? '').replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[c]);

let draft = null;
let bootstrap = null;
let pairingTimers = new Map();
let cleanupTarget = '';

function blankStudent() {
  return { key: crypto.randomUUID(), name: '', phone: '', rollNumber: '', telegramUserId: '', telegramGroupId: '', telegramGroupName: '' };
}

function blankDraft() {
  return {
    schema: 1, id: '', folder: '', displayName: '', classNumber: '', section: '', subject: '', model: '', updatedAt: new Date(0).toISOString(),
    tutor: { name: '', phone: '', telegramUserId: '', telegramGroupId: '', telegramGroupName: '' },
    students: [blankStudent()],
  };
}

async function api(url, options = {}) {
  const init = { ...options, headers: { ...(options.headers || {}) } };
  if (init.body && typeof init.body !== 'string') {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(init.body);
  }
  if ((init.method || 'GET') === 'POST') init.headers[actionHeader] = actionToken;
  const target = url.startsWith('/api') ? `${apiBase}${url.slice(4)}` : url;
  const response = await fetch(target, init);
  const value = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
  if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
  return value;
}

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('toasts').append(el);
  setTimeout(() => el.remove(), 5200);
}

function slugify(value) {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 42);
}

function derive() {
  const classLabel = [draft.classNumber.trim(), draft.section.trim()].filter(Boolean).join(' – ');
  const base = slugify(`${classLabel}-${draft.subject}`) || 'new-class';
  return {
    id: draft.id.trim() || `ag-${base}`.slice(0, 50),
    folder: draft.folder.trim() || base.slice(0, 64),
    displayName: draft.displayName.trim() || `${classLabel} ${draft.subject} Tutor`.trim(),
    classLabel,
  };
}

function readStaticFields() {
  draft.classNumber = $('classNumber').value;
  draft.section = $('section').value;
  draft.subject = $('subject').value;
  draft.tutor.name = $('tutorName').value;
  draft.tutor.phone = $('tutorPhone').value;
  draft.tutor.telegramUserId = $('tutorTelegramUserId').value;
  draft.tutor.telegramGroupId = $('tutorTelegramGroupId').value;
  draft.tutor.telegramGroupName = $('tutorTelegramGroupName').value;
  draft.id = $('appId').value;
  draft.folder = $('folder').value;
  draft.model = $('model').value;
  for (const card of document.querySelectorAll('.student-card')) {
    const student = draft.students.find((item) => item.key === card.dataset.key);
    if (!student) continue;
    card.querySelectorAll('[data-field]').forEach((input) => { student[input.dataset.field] = input.value; });
  }
  return draft;
}

function loadFields() {
  $('classNumber').value = draft.classNumber || '';
  $('section').value = draft.section || '';
  $('subject').value = draft.subject || '';
  $('tutorName').value = draft.tutor.name || '';
  $('tutorPhone').value = draft.tutor.phone || '';
  $('tutorTelegramUserId').value = draft.tutor.telegramUserId || '';
  $('tutorTelegramGroupId').value = draft.tutor.telegramGroupId || '';
  $('tutorTelegramGroupName').value = draft.tutor.telegramGroupName || '';
  $('appId').value = draft.id || '';
  $('folder').value = draft.folder || '';
  $('model').value = draft.model || '';
  renderStudents();
  updateReview();
}

function paired(person) { return Boolean(person.telegramUserId && person.telegramGroupId); }

function renderStudents() {
  $('studentList').innerHTML = draft.students.map((student, index) => `
    <div class="student-card" data-key="${esc(student.key)}">
      <div class="student-head">
        <div class="student-title"><b>${String(index + 1).padStart(2, '0')}</b><span>${esc(student.name || `Student ${index + 1}`)}<small>${paired(student) ? `Paired · ${esc(student.telegramGroupName || student.telegramGroupId)}` : 'Awaiting private Telegram room'}</small></span></div>
        ${draft.students.length > 1 ? `<button class="remove-student" data-remove="${esc(student.key)}">Remove</button>` : ''}
      </div>
      <div class="student-fields">
        <label><span>Student name *</span><input data-field="name" value="${esc(student.name)}" placeholder="Student persona"></label>
        <label><span>Roll / student no.</span><input data-field="rollNumber" value="${esc(student.rollNumber)}" placeholder="e.g. 17"></label>
        <label><span>Phone number</span><input data-field="phone" value="${esc(student.phone)}" placeholder="Local reference"></label>
      </div>
      <div class="student-pair">
        <button class="button ${paired(student) ? 'quiet' : 'dark'}" data-pair-student="${esc(student.key)}">${paired(student) ? 'Pair again' : 'Pair student group'}</button>
        <span class="student-pair-state ${paired(student) ? 'ok' : ''}">${paired(student) ? '✓ Telegram room ready' : 'Send the code from this student’s account'}</span>
        <span class="inline-code" data-code-for="${esc(student.key)}"><small>Send code</small><b>••••</b></span>
      </div>
      <details class="advanced"><summary>Advanced · paired Telegram identifiers</summary><div class="field-grid three"><label><span>Student Telegram user ID</span><input data-field="telegramUserId" value="${esc(student.telegramUserId)}" placeholder="telegram:123…"></label><label><span>Student group ID</span><input data-field="telegramGroupId" value="${esc(student.telegramGroupId)}" placeholder="telegram:-100…"></label><label><span>Student group name</span><input data-field="telegramGroupName" value="${esc(student.telegramGroupName)}" placeholder="Filled by pairing"></label></div></details>
    </div>`).join('');
  bindStudentEvents();
}

function bindStudentEvents() {
  document.querySelectorAll('.student-card input').forEach((el) => el.addEventListener('input', () => { readStaticFields(); updateReview(); }));
  document.querySelectorAll('[data-remove]').forEach((button) => button.addEventListener('click', () => {
    readStaticFields();
    draft.students = draft.students.filter((student) => student.key !== button.dataset.remove);
    renderStudents(); updateReview();
  }));
  document.querySelectorAll('[data-pair-student]').forEach((button) => button.addEventListener('click', () => pairRole('student', button.dataset.pairStudent)));
}

function clientValidation() {
  const errors = [];
  if (!draft.classNumber.trim()) errors.push('Enter the class number or label.');
  if (!draft.subject.trim()) errors.push('Enter the subject.');
  if (!draft.tutor.name.trim()) errors.push('Enter the tutor name.');
  if (!paired(draft.tutor)) errors.push('Pair the tutor control group.');
  draft.students.forEach((student, i) => {
    if (!student.name.trim()) errors.push(`Enter Student ${i + 1} name.`);
    if (!paired(student)) errors.push(`Pair Student ${i + 1} group.`);
  });
  const users = [draft.tutor, ...draft.students].map((p) => p.telegramUserId).filter(Boolean);
  if (new Set(users).size !== users.length) errors.push('Tutor and students must use different Telegram accounts.');
  const groups = [draft.tutor, ...draft.students].map((p) => p.telegramGroupId).filter(Boolean);
  if (new Set(groups).size !== groups.length) errors.push('Every role needs a different Telegram group.');
  return errors;
}

function setComplete(id, done) {
  const el = $(id); el.textContent = done ? '●' : '○'; el.classList.toggle('done', done);
}

function updateReview() {
  readStaticFields();
  const d = derive();
  $('tutorRoomLabel').textContent = draft.tutor.telegramGroupName || `${d.classLabel || 'Class'} — Tutor Control`;
  const tutorReady = paired(draft.tutor);
  $('tutorPairState').textContent = tutorReady ? 'Paired' : 'Not paired';
  $('tutorPairState').classList.toggle('ok', tutorReady);
  setComplete('classComplete', Boolean(draft.classNumber && draft.subject && draft.tutor.name));
  setComplete('tutorComplete', tutorReady);
  setComplete('studentsComplete', draft.students.length > 0 && draft.students.every((s) => s.name && paired(s)));
  $('reviewSummary').innerHTML = [
    ['Class', d.classLabel || 'Not set'], ['Subject', draft.subject || 'Not set'], ['Tutor', draft.tutor.name || 'Not set'], ['Chat sessions', `${1 + draft.students.length} planned`], ['Containers', 'On demand'],
  ].map(([label, value]) => `<div class="review-stat"><small>${esc(label)}</small><b>${esc(value)}</b></div>`).join('');
  const errors = clientValidation();
  const box = $('validationBox');
  if (errors.length) {
    box.className = 'validation-box bad';
    box.innerHTML = `<b>${errors.length} item${errors.length === 1 ? '' : 's'} remaining</b><span>${esc(errors.slice(0, 3).join(' · '))}</span>`;
  } else {
    box.className = 'validation-box good';
    box.innerHTML = `<b>Ready to create class wiring</b><span>Creates one shared tutor application with ${1 + draft.students.length} private chat sessions. Containers start when those rooms receive their first message.</span>`;
  }
  $('instantiate').disabled = errors.length > 0;
}

async function saveDraft(showToast = true) {
  readStaticFields();
  const d = derive();
  draft.id = d.id; draft.folder = d.folder; draft.displayName = d.displayName;
  const result = await api('/api/draft', { method: 'POST', body: { draft } });
  draft = result.record.draft;
  $('appId').value = draft.id; $('folder').value = draft.folder;
  if (showToast) toast('Draft saved locally.', 'ok');
  return result;
}

async function pairRole(role, studentKey = null) {
  try {
    readStaticFields();
    const person = role === 'tutor' ? draft.tutor : draft.students.find((s) => s.key === studentKey);
    if (role === 'student' && !person.name.trim()) return toast('Enter the student name before pairing.', 'error');
    await saveDraft(false);
    const result = await api('/api/pairings', { method: 'POST', body: { draft, role, slot: studentKey || 'tutor' } });
    const codeEl = role === 'tutor' ? $('tutorPairCode') : document.querySelector(`[data-code-for="${CSS.escape(studentKey)}"]`);
    codeEl.hidden = false; codeEl.classList.add('show');
    codeEl.querySelector('strong, b').textContent = result.code;
    if (role === 'tutor') codeEl.querySelector('span').textContent = 'Waiting for a message from the tutor account…';
    toast(`Pairing code ${result.code} created. Send it in the Telegram group.`);
    pollPairing(result.code, role, studentKey);
  } catch (error) { toast(error.message, 'error'); }
}

function pollPairing(code, role, studentKey) {
  const key = `${role}:${studentKey || ''}`;
  clearInterval(pairingTimers.get(key));
  const tick = async () => {
    try {
      const result = await api(`/api/pairings/${code}`);
      if (result.status === 'pending') return;
      clearInterval(pairingTimers.get(key)); pairingTimers.delete(key);
      if (result.status !== 'consumed' || !result.consumed?.isGroup) {
        return toast(result.status === 'consumed' ? 'That was not a Telegram group. Create a private group and pair again.' : 'Pairing code was invalidated. Generate a new one.', 'error');
      }
      const person = role === 'tutor' ? draft.tutor : draft.students.find((s) => s.key === studentKey);
      person.telegramUserId = result.consumed.telegramUserId;
      person.telegramGroupId = result.consumed.platformId;
      person.telegramGroupName = result.consumed.name || person.telegramGroupName;
      if (role === 'tutor') $('tutorPairCode').hidden = true;
      loadFields(); await saveDraft(false);
      toast(`${role === 'tutor' ? 'Tutor control' : person.name} group paired successfully.`, 'ok');
    } catch (error) { clearInterval(pairingTimers.get(key)); toast(error.message, 'error'); }
  };
  pairingTimers.set(key, setInterval(tick, 1200));
  tick();
}

async function instantiate() {
  const button = $('instantiate');
  try {
    await saveDraft(false);
    button.disabled = true; button.textContent = 'Creating class wiring…';
    const result = await api('/api/instantiate', { method: 'POST', body: { draft } });
    toast(`Class tutor ${result.id} is ready.`, 'ok');
    await refreshStatus();
    switchTab('status');
  } catch (error) { toast(error.message, 'error'); }
  finally { button.textContent = 'Create class & enable rooms →'; updateReview(); }
}

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach((panel) => panel.classList.toggle('active', panel.id === name));
  if (name === 'status') refreshStatus();
  history.replaceState(null, '', `#${name}`);
}

function statusValue(instance, key, fallback = 0) {
  return instance.error ? '—' : instance.application?.[key] ?? fallback;
}

function renderApplicationInfo(instance, draft, application) {
  if (!application) {
    return instance.error ? `<div class="status-error"><b>Status unavailable</b><span>${esc(String(instance.error).replace(/\s+/g, ' ').slice(0, 500))}</span></div>` : '';
  }
  const classInfo = application.class || {};
  const tutor = application.tutor || {};
  const roster = Array.isArray(application.roster) ? application.roster : [];
  const configuredClass = [draft.classNumber, draft.section].filter(Boolean).join(' – ');
  return `<div class="application-info">
    <div class="info-panel"><small>Application</small><dl class="info-list">
      <div><dt>Class</dt><dd>${esc(classInfo.class_name || configuredClass || '—')}</dd></div>
      <div><dt>Subject</dt><dd>${esc(classInfo.subject || draft.subject || '—')}</dd></div>
      <div><dt>Application ID</dt><dd>${esc(application.id || draft.id || '—')}</dd></div>
      <div><dt>Workspace</dt><dd>${esc(application.folder || '—')}</dd></div>
    </dl></div>
    <div class="info-panel"><small>Tutor</small><div class="person-row">
      <span class="person-avatar">${esc((tutor.name || 'T')[0].toUpperCase())}</span><div><b>${esc(tutor.name || 'Tutor not configured')}</b><span>${tutor.paired ? 'Telegram control group paired' : 'Telegram control group not paired'}</span></div>
    </div></div>
    <div class="info-panel students-panel"><small>Students</small>${roster.length ? `<div class="person-list">${roster.map((student, index) => `<div class="person-row"><span class="person-avatar">${String(index + 1).padStart(2, '0')}</span><div><b>${esc(student.name || `Student ${index + 1}`)}</b><span>${student.rollNumber ? `Roll / student no. ${esc(student.rollNumber)} · ` : ''}${student.paired ? 'Private room paired' : 'Private room not paired'}</span></div></div>`).join('')}</div>` : '<p class="info-empty">No students configured.</p>'}</div>
  </div>`;
}

function renderStatus(data) {
  $('statusCount').textContent = String(data.instances.length);
  if (!data.instances.length) {
    $('statusGrid').innerHTML = '<div class="empty-state"><span>◎</span><h3>No tutor instances yet</h3><p>Complete Configuration to create the first one.</p></div>';
    return;
  }
  $('statusGrid').innerHTML = data.instances.map((instance) => {
    const record = instance.record;
    const d = record?.draft || {};
    const application = instance.application;
    const hasError = Boolean(instance.error);
    const desired = hasError ? 'error' : instance.lifecycle?.desiredState || (instance.installed ? 'running' : 'absent');
    const lifecycleStatus = instance.lifecycle?.status;
    const stateLabel = hasError || lifecycleStatus === 'error' ? 'error' : desired === 'paused' ? 'paused' : desired === 'stopped' ? 'stopped' : lifecycleStatus === 'starting' ? 'starting' : lifecycleStatus === 'running' ? 'active' : instance.installed ? 'ready' : 'not created';
    const runtimeLabel = hasError || lifecycleStatus === 'error' ? 'Error' : desired === 'paused' ? 'Paused' : desired === 'stopped' ? 'Stopped' : lifecycleStatus === 'starting' ? 'Starting' : lifecycleStatus === 'running' ? 'Active' : instance.installed ? 'On demand' : 'Not created';
    const studentCount = statusValue(instance, 'students', d.students?.length || 0);
    const materials = application?.materials;
    const materialDisplay = hasError ? '—' : materials ? `${materials.active || 0} active / ${materials.proposed || 0} review` : '0 active / 0 review';
    const materialTitle = materials?.missing_files ? `${materials.missing_files} material file(s) missing` : 'Shared concept-linked materials';
    const classInfo = application?.class || {};
    const subject = classInfo.subject || d.subject;
    const classLabel = classInfo.class_name || [d.classNumber, d.section].filter(Boolean).join(' – ');
    return `<article class="status-card" data-instance="${esc(d.id)}">
      <div class="status-card-head"><div class="status-title"><span class="status-avatar">${esc((subject || 'T')[0].toUpperCase())}</span><div><h3>${esc(application?.name || d.displayName || d.id)}</h3><p>${esc(application?.id || d.id)} · ${esc(classLabel)} · ${esc(subject)}</p></div></div><span class="state-badge ${stateLabel === 'error' ? 'error' : stateLabel === 'paused' ? 'paused' : stateLabel === 'stopped' || stateLabel === 'not created' ? 'absent' : ''}">${esc(stateLabel)}</span></div>
      <div class="status-body">
        <div class="metric"><small>Students</small><b>${esc(studentCount)}</b></div>
        <div class="metric"><small>Knowledge graphs</small><b>${esc(statusValue(instance, 'graphs', 0))}</b></div>
        <div class="metric"><small>Course revision</small><b>${esc(statusValue(instance, 'courseRevisions', 0))}</b></div>
        <div class="metric" title="${esc(materialTitle)}"><small>Materials</small><b>${esc(materialDisplay)}</b></div>
        <div class="metric"><small>Initialized</small><b>${statusValue(instance, 'initialized', false) === '—' ? '—' : statusValue(instance, 'initialized', false) ? 'Yes' : 'No'}</b></div>
        <div class="metric" title="A session container is created when a paired room sends a message"><small>Runtime</small><b>${esc(runtimeLabel)}</b></div>
      </div>
      ${renderApplicationInfo(instance, d, application)}
      <div class="status-actions">
        ${instance.installed && desired === 'paused' ? `<button class="button primary" data-action="resume">Resume class</button>` : ''}
        ${instance.installed && desired !== 'paused' ? `<button class="button quiet" data-action="shutdown">Pause / shut down</button>` : ''}
        ${instance.installed ? `<button class="button quiet" data-action="restart">Restart containers</button>` : ''}
        <button class="button quiet" data-edit>Edit configuration</button>
        ${instance.installed ? `<button class="button quiet cleanup" data-cleanup>Clean up…</button>` : ''}
      </div>
    </article>`;
  }).join('');
  bindStatusActions();
}

function bindStatusActions() {
  document.querySelectorAll('[data-action]').forEach((button) => button.addEventListener('click', async () => {
    const card = button.closest('[data-instance]');
    button.disabled = true;
    try { await api(`/api/instances/${card.dataset.instance}/action`, { method: 'POST', body: { action: button.dataset.action } }); toast('Class state updated.', 'ok'); await refreshStatus(); }
    catch (error) { toast(error.message, 'error'); button.disabled = false; }
  }));
  document.querySelectorAll('[data-edit]').forEach((button) => button.addEventListener('click', () => {
    const id = button.closest('[data-instance]').dataset.instance;
    const record = bootstrap.drafts.find((item) => item.draft.id === id);
    if (record) { draft = structuredClone(record.draft); loadFields(); switchTab('configuration'); window.scrollTo({ top: 280, behavior: 'smooth' }); }
  }));
  document.querySelectorAll('[data-cleanup]').forEach((button) => button.addEventListener('click', () => {
    cleanupTarget = button.closest('[data-instance]').dataset.instance;
    $('cleanupTitle').textContent = `Clean up ${cleanupTarget}`;
    $('cleanupCopy').textContent = 'Pause and remove this class registration. Choose whether to retain local files for recovery or permanently purge everything.';
    $('cleanupConfirmation').value = '';
    $('cleanupDialog').showModal();
  }));
}

async function refreshStatus() {
  try {
    const data = await api('/api/status');
    renderStatus(data);
    const boot = await api('/api/bootstrap'); bootstrap.drafts = boot.drafts;
  } catch (error) { toast(error.message, 'error'); }
}

async function init() {
  try {
    bootstrap = await api('/api/bootstrap');
    const latest = bootstrap.drafts.find((item) => !item.deletedAt) || bootstrap.drafts[0];
    draft = latest ? structuredClone(latest.draft) : blankDraft();
    if (!draft.students?.length) draft.students = [blankStudent()];
    loadFields();
    if (location.hash === '#status') switchTab('status');
  } catch (error) { toast(`Could not load Tutor Foundry: ${error.message}`, 'error'); draft = blankDraft(); loadFields(); }
}

document.querySelectorAll('.tab').forEach((button) => button.addEventListener('click', () => switchTab(button.dataset.tab)));
document.querySelectorAll('[data-scroll]').forEach((button) => button.addEventListener('click', () => $(button.dataset.scroll).scrollIntoView({ behavior: 'smooth' })));
document.querySelectorAll('[data-tab-link]').forEach((button) => button.addEventListener('click', () => switchTab(button.dataset.tabLink)));
document.querySelectorAll('#classStep input, #tutorStep input').forEach((input) => input.addEventListener('input', updateReview));
$('addStudent').addEventListener('click', () => { readStaticFields(); draft.students.push(blankStudent()); renderStudents(); updateReview(); });
$('saveDraft').addEventListener('click', () => saveDraft().catch((error) => toast(error.message, 'error')));
$('pairTutor').addEventListener('click', () => pairRole('tutor'));
$('instantiate').addEventListener('click', instantiate);
$('refreshStatus').addEventListener('click', refreshStatus);
$('confirmCleanup').addEventListener('click', async (event) => {
  event.preventDefault();
  const purge = document.querySelector('input[name="cleanupMode"]:checked').value === 'purge';
  try {
    await api(`/api/instances/${cleanupTarget}/cleanup`, { method: 'POST', body: { purge, confirmation: $('cleanupConfirmation').value } });
    $('cleanupDialog').close(); toast(purge ? 'Tutor and all local data permanently purged.' : 'Tutor removed; local files retained for recovery.', 'ok'); await refreshStatus();
  } catch (error) { toast(error.message, 'error'); }
});
init();
