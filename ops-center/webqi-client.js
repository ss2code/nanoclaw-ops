window.addEventListener('DOMContentLoaded', function () {
  const el = (id) => document.getElementById(id);
  const esc = (value) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  const initial = new URLSearchParams(location.search);
  const state = {
    snapshot: null,
    group: null,
    session: null,
    root: null,
    rootId: null,
    branch: null,
    fresh: initial.get('new') === '1',
    busy: false,
    timer: null,
    token: 0,
    signature: '',
    pendingTag: null,
    trash: null,
    requestAt: null,
  };
  const presets = { quick: 'distill', verify: 'critique', decide: 'referee' };
  const title = (r) => r.question?.replace(/\s+/g, ' ').slice(0, 80) || r.tag;
  const query = (root = state.rootId) =>
    new URLSearchParams({ group: state.group.id, session: state.session.id, ...(root ? { root } : {}) });
  const sourceUrl = (n) => '/api/webqi/source?' + query() + '&node=' + encodeURIComponent(n.id);
  function resetSettings() {
    el('wi-protocol').value = 'quick';
    el('wi-lens').value = 'distill';
    el('wi-preset').value = 'quick';
    el('wi-tag').value = '';
  }
  function syncPreset() {
    const p = el('wi-protocol').value;
    el('wi-preset').value = presets[p] === el('wi-lens').value ? p : 'custom';
  }
  function composer() {
    const closed = state.root && state.root.status !== 'open';
    el('wi-question-label').textContent = state.fresh
      ? 'Your question'
      : state.branch
        ? 'Explore separately'
        : 'Ask a follow-up';
    el('wi-submit').textContent = state.fresh
      ? 'Get second opinion'
      : closed
        ? 'Reopen & continue'
        : state.branch
          ? 'Ask panel · separate branch'
          : 'Ask panel';
    el('wi-submit').disabled = state.busy || !state.session || (!state.fresh && !state.root);
    el('wi-context').textContent = state.fresh
      ? 'New topic · ' + (state.session?.conversationName || 'choose a conversation')
      : state.branch
        ? 'Exploring from ' + state.branch
        : 'Continuing: ' + (state.root ? title(state.root) : 'choose a topic');
    el('wi-cancel-branch').hidden = !state.branch;
    el('wi-tag').disabled = !state.fresh;
    el('wi-close').disabled = !state.root || closed || state.busy;
    el('wi-delete').disabled = !state.root || state.busy;
    const count = document.querySelectorAll('#wi-targets input:checked').length;
    el('wi-panel-summary').textContent = count
      ? count + ' selected model(s) · configured settings'
      : 'Automatic panel · up to ' +
        (['quick', 'debate', 'redteam'].includes(el('wi-protocol').value) ? 2 : 3) +
        ' distinct other models';
  }
  function renderTopics() {
    el('wi-roots').innerHTML =
      (state.session?.store.roots || [])
        .map(
          (r) =>
            '<button class="consult-topic ' +
            (r.id === state.rootId ? 'selected' : '') +
            '" data-topic="' +
            esc(r.id) +
            '">' +
            esc(title(r)) +
            '<small>' +
            esc(r.status) +
            '</small></button>',
        )
        .join('') || '<p class="muted small">No topics yet. Ask your first question.</p>';
  }
  function renderModels() {
    el('wi-targets').innerHTML =
      (state.session?.targets || [])
        .map(
          (t) =>
            '<div class="consult-model"><label><input type="checkbox" value="' +
            esc(t.name) +
            '"> ' +
            esc(t.displayName || t.name) +
            '<small>' +
            esc(t.model || 'Model discovered automatically') +
            '</small></label><select aria-label="Settings for ' +
            esc(t.displayName || t.name) +
            '" data-target="' +
            esc(t.name) +
            '"><option value="">Configured default</option>' +
            Object.entries(t.tiers || {})
              .filter(([k]) => k !== 'default')
              .map(([k, v]) => '<option value="' + esc(k) + '">' + esc(k + ' · ' + v) + '</option>')
              .join('') +
            '</select></div>',
        )
        .join('') || '<p class="muted small">Models will be discovered when you ask.</p>';
  }
  function renderRoot() {
    const r = state.root;
    el('wi-title').textContent = r ? title(r) : 'Get a second opinion';
    el('wi-topic-status').textContent = r?.status || '';
    el('wi-summary').textContent = r
      ? ''
      : 'Ask a question to get a combined answer, differences, and remaining uncertainty.';
    el('wi-details').hidden = !r;
    if (!r) {
      el('wi-conversation').innerHTML = '';
      composer();
      return;
    }
    const completed = (n) => n.status === 'complete' && n.content != null;
    const questions = r.nodes.filter((n) => n.type === 'question');
    const turnFor = new Map(questions.map((n) => [n.id, n.id]));
    r.nodes.forEach((n) => {
      if (n.questionNodeId) turnFor.set(n.id, n.questionNodeId);
    });
    // Follow only derivation edges; continuation/branch edges start a new turn.
    for (let i = 0; i < r.nodes.length; i++) {
      let changed = false;
      for (const e of r.edges) {
        if (['derives', 'judges', 'critiques'].includes(e.type) && turnFor.has(e.from) && !turnFor.has(e.to)) {
          turnFor.set(e.to, turnFor.get(e.from));
          changed = true;
        }
      }
      if (!changed) break;
    }
    el('wi-conversation').innerHTML = questions
      .slice(-12)
      .map((q) => {
        const answers = r.nodes.filter((n) => n.type === 'answer' && n.questionNodeId === q.id);
        const outputs = r.nodes.filter((n) => !['question', 'answer'].includes(n.type) && turnFor.get(n.id) === q.id);
        const done = answers.filter(completed);
        const result = outputs.filter(completed).at(-1);
        const answerText = result
          ? '<div class="consult-answer">' + esc(result.content) + '</div>'
          : '<p class="muted">' +
            (answers.length === 0
              ? 'No external model was selected. Check available models in Options.'
              : done.length === answers.length
                ? 'Combining the model replies…'
                : 'Waiting for model replies…') +
            '</p>';
        const sources = answers
          .map(
            (n) =>
              '<details class="consult-source"><summary>' +
              esc(n.label || n.sourceName || 'Model answer') +
              ' · ' +
              esc(n.status) +
              '</summary>' +
              (completed(n)
                ? '<div class="consult-answer">' +
                  esc(n.content) +
                  '</div><a target="_blank" rel="noopener" href="' +
                  esc(sourceUrl(n)) +
                  '">Open original answer</a>'
                : '<p class="muted">Still waiting for this model.</p>') +
              '</details>',
          )
          .join('');
        return (
          '<article class="consult-turn"><div class="consult-question">' +
          esc(q.content || q.preview) +
          '</div><p class="muted small">' +
          done.length +
          ' of ' +
          answers.length +
          ' models replied' +
          (result ? ' · Combined answer' : '') +
          '</p>' +
          answerText +
          '<details><summary>Original model answers (' +
          done.length +
          ')</summary>' +
          sources +
          '</details><div class="consult-actions">' +
          (done.length
            ? '<button type="button" class="linkbtn" data-explain="' +
              esc(q.id) +
              '">Explain the disagreement · existing answers</button>'
            : '') +
          '<button type="button" class="linkbtn" data-branch="' +
          esc(result?.id || q.id) +
          '">Explore separately</button></div></article>'
        );
      })
      .join('');
    const full = '/api/webqi/conversation?' + query();
    el('wi-graph-file').innerHTML =
      '<a target="_blank" rel="noopener" href="' +
      esc(full) +
      '">Open full conversation</a> · <a target="_blank" rel="noopener" href="/api/webqi/graph-file?' +
      esc(query()) +
      '">Open graph.json</a>';
    el('wi-badges').textContent = r.id + ' · ' + r.tag + ' · ' + r.protocol + ' · ' + r.defaultLens;
    el('wi-graph').innerHTML = r.nodes
      .map(
        (n) =>
          '<article class="webqi-node"><b>' +
          esc(n.id) +
          ' · ' +
          esc(n.label || n.type) +
          '</b><p>' +
          esc(n.preview || n.status) +
          '</p>' +
          r.edges
            .filter((e) => e.to === n.id)
            .map((e) => '<small>' + esc(e.type + ' from ' + e.from) + '</small>')
            .join(' · ') +
          '<div class="consult-actions"><button class="linkbtn" data-branch="' +
          esc(n.id) +
          '">Explore separately from here</button>' +
          (n.hasContent
            ? '<a target="_blank" rel="noopener" href="' + esc(sourceUrl(n)) + '">Open exact source</a>'
            : '') +
          '</div></article>',
      )
      .join('');
    composer();
  }
  async function api(url, body) {
    const r = await fetch(
      url,
      body
        ? {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-ops-action-token': window.__opsToken },
            body: JSON.stringify(body),
          }
        : { cache: 'no-store' },
    );
    const j = await r.json();
    if (!r.ok || j.ok === false) throw new Error(j.message || 'Request failed');
    return j;
  }
  async function loadRoot(id, reset = true) {
    const token = ++state.token;
    state.rootId = id;
    state.fresh = !id;
    state.branch = null;
    state.signature = '';
    state.root = null;
    renderRoot();
    renderTopics();
    if (!id) return;
    try {
      const j = await api('/api/webqi/graph?' + query(id));
      if (token !== state.token) return;
      state.root = j.root;
      if (reset) {
        el('wi-protocol').value = j.root.protocol;
        el('wi-lens').value = j.root.defaultLens;
        syncPreset();
      }
      state.signature = JSON.stringify(j.root);
      renderRoot();
    } catch (e) {
      if (token === state.token) el('wi-live').textContent = e.message;
    }
  }
  function selectSession(preferred) {
    state.token++;
    state.session =
      (preferred ? state.group?.sessions.find((s) => s.id === preferred) : state.group?.sessions[0]) || null;
    state.root = null;
    state.rootId = null;
    state.pendingTag = null;
    state.trash = null;
    el('wi-undo').hidden = true;
    el('wi-session').innerHTML =
      (!state.session ? '<option value="">Choose a conversation</option>' : '') +
      (state.group?.sessions || [])
        .map(
          (s) => '<option value="' + esc(s.id) + '">' + esc(s.conversationName + ' · ' + s.channelType) + '</option>',
        )
        .join('');
    el('wi-session').value = state.session?.id || '';
    el('wi-session-meta').textContent = state.session
      ? 'Topics stay in this conversation.'
      : 'Start a normal chat with this agent first to create a conversation.';
    resetSettings();
    renderModels();
    renderTopics();
    const id = state.fresh ? null : state.session?.store.activeRootId || state.session?.store.roots[0]?.id || null;
    loadRoot(id);
  }
  async function refresh(first = false) {
    try {
      const j = await api('/api/webqi/bootstrap');
      state.snapshot = j;
      if (first) {
        el('wi-group').innerHTML = j.groups
          .map((g) => '<option value="' + esc(g.id) + '">' + esc(g.name) + '</option>')
          .join('');
        state.group = j.groups.find((g) => g.id === initial.get('group')) || j.groups[0] || null;
        el('wi-group').value = state.group?.id || '';
        selectSession(
          initial.get('session') ||
            (initial.get('web') === '1'
              ? state.group?.sessions.find((s) => s.channelType === 'cli' && s.platformId === 'web:' + state.group.id)
                  ?.id || '__no_web_session__'
              : null),
        );
      } else {
        const g = j.groups.find((g) => g.id === state.group?.id);
        const s = g?.sessions.find((s) => s.id === state.session?.id);
        if (s) {
          state.group = g;
          state.session = s;
          renderTopics();
          if (state.pendingTag) {
            const created = s.store.roots.find((r) => r.tag === state.pendingTag);
            if (created) {
              state.pendingTag = null;
              await loadRoot(created.id, false);
            }
          }
        }
      }
    } catch (e) {
      el('wi-live').textContent = 'Could not refresh: ' + e.message;
    }
  }
  async function poll() {
    clearTimeout(state.timer);
    try {
      if (state.session) {
        const token = state.token;
        const params = query();
        const j = await api('/api/webqi/activity?' + params);
        if (token !== state.token) return;
        el('wi-activity').innerHTML = (j.messages || [])
          .map((m) => '<p class="consult-answer"><b>' + esc(m.role) + '</b> ' + esc(m.text) + '</p>')
          .join('');
        el('wi-live').textContent =
          j.status === 'working'
            ? 'Agent working…'
            : j.status === 'queued'
              ? 'Request queued…'
              : state.pendingTag
                ? 'Starting your topic…'
                : '';
        if (state.rootId) {
          const data = await api('/api/webqi/graph?' + params);
          if (token !== state.token) return;
          const signature = JSON.stringify(data.root);
          if (signature !== state.signature) {
            state.signature = signature;
            state.root = data.root;
            renderRoot();
          }
        }
        await refresh();
      }
    } catch (e) {
      el('wi-live').textContent = 'Connection interrupted. Retrying automatically…';
    } finally {
      state.timer = setTimeout(poll, 3000);
    }
  }
  async function submit(action, extra = {}) {
    if (state.busy || !state.session) return;
    const question = el('wi-question').value.trim();
    const asking = ['new', 'continue', 'branch', 'reopen-continue'].includes(action);
    if (asking && !question) {
      el('wi-question').focus();
      return;
    }
    state.busy = true;
    composer();
    const token = state.token;
    const targets = [...document.querySelectorAll('#wi-targets input:checked')].map((n) => n.value);
    const tiers = {};
    document.querySelectorAll('#wi-targets select').forEach((s) => {
      if (targets.includes(s.dataset.target) && s.value) tiers[s.dataset.target] = s.value;
    });
    const tag = action === 'new' ? el('wi-tag').value.trim() || 'topic-' + crypto.randomUUID().slice(0, 8) : undefined;
    try {
      await api('/api/webqi/action', {
        action,
        groupId: state.group.id,
        sessionId: state.session.id,
        rootId: state.rootId,
        ref: state.branch || state.rootId,
        question,
        protocol: el('wi-protocol').value,
        lens: el('wi-lens').value,
        targets,
        tiers,
        tag,
        ...extra,
      });
      if (token !== state.token) return;
      el('wi-live').textContent = 'Request sent. Waiting for the agent…';
      if (asking) el('wi-question').value = '';
      if (action === 'new')
        state.pendingTag = tag
          .toLowerCase()
          .replace(/[^a-z0-9_-]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 48);
      if (action === 'delete') {
        state.trash = state.rootId;
        el('wi-undo').hidden = false;
        await loadRoot(null);
      }
      if (action === 'restore') {
        state.trash = null;
        el('wi-undo').hidden = true;
      }
      setTimeout(poll, 700);
    } catch (e) {
      el('wi-live').textContent = e.message;
      toast(e.message, false);
    } finally {
      state.busy = false;
      composer();
    }
  }
  el('wi-form').onsubmit = (e) => {
    e.preventDefault();
    submit(
      state.fresh ? 'new' : state.root?.status !== 'open' ? 'reopen-continue' : state.branch ? 'branch' : 'continue',
    );
  };
  el('wi-new-root').onclick = () => {
    resetSettings();
    loadRoot(null);
    el('wi-question').focus();
  };
  el('wi-roots').onclick = (e) => {
    const b = e.target.closest('[data-topic]');
    if (b) loadRoot(b.dataset.topic);
  };
  el('wi-group').onchange = () => {
    state.group = state.snapshot.groups.find((g) => g.id === el('wi-group').value);
    state.fresh = false;
    selectSession();
  };
  el('wi-session').onchange = () => {
    state.fresh = false;
    selectSession(el('wi-session').value);
  };
  el('wi-preset').onchange = () => {
    const p = el('wi-preset').value;
    if (presets[p]) {
      el('wi-protocol').value = p;
      el('wi-lens').value = presets[p];
    } else el('wi-advanced').open = true;
    composer();
  };
  ['wi-protocol', 'wi-lens'].forEach(
    (id) =>
      (el(id).onchange = () => {
        syncPreset();
        composer();
      }),
  );
  el('wi-targets').onchange = composer;
  el('wi-cancel-branch').onclick = () => {
    state.branch = null;
    composer();
  };
  document.querySelector('.consult-main').addEventListener('click', (e) => {
    const branch = e.target.closest('[data-branch]');
    if (branch) {
      state.branch = branch.dataset.branch;
      composer();
      el('wi-question').focus();
    }
    const explain = e.target.closest('[data-explain]');
    if (explain) submit('reprocess', { ref: explain.dataset.explain, lens: 'contrast' });
  });
  el('wi-close').onclick = () => submit('close');
  el('wi-delete').onclick = () => submit('delete');
  el('wi-restore').onclick = () => submit('restore', { rootId: state.trash, ref: state.trash });
  el('wi-roster').onclick = () => submit('roster');
  el('wi-refresh').onclick = () => poll();
  refresh(true).then(poll);
});
