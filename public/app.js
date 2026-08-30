/* ============================================================ Kimo ===
 * Front-end. Talks only to this app's own /api/* routes — the xKiro key
 * lives on the server (or in localStorage if the user pastes one).
 * ========================================================================= */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const DEFAULT_MODEL = 'z-ai/glm-5.3-flash';
  const SERVER_DOWN_HINT =
    'Could not reach the app server. It is not running — start it again with ' +
    '`node server.js` in the xkiro-chat folder, then resend. (A dead port answers ' +
    'POST requests with HTTP 405, which is what this error usually is.)';

  // Vendor identity: label, colour, and logo file when we have one.
  const VENDORS = {
    'z-ai':      { label: 'Z.AI · GLM',  color: '#2f3136', logo: 'assets/glm.jpg' },
    openai:      { label: 'OpenAI',      color: '#10a37f', logo: 'assets/openai.png' },
    anthropic:   { label: 'Anthropic',   color: '#d97757', logo: 'assets/claude.png' },
    google:      { label: 'Google',      color: '#4285f4', logo: 'assets/gemini.jpg' },
    deepseek:    { label: 'DeepSeek',    color: '#4d6bfe', logo: 'assets/deepseek.png' },
    qwen:        { label: 'Qwen',        color: '#615ced', logo: 'assets/qwen.png' },
    'x-ai':      { label: 'xAI',         color: '#1a1a1a', logo: 'assets/grok.png', plate: true },
    // Kimi's mark is a white K already sitting on its own black tile, so it
    // needs no plate — adding one would hide it.
    moonshotai:  { label: 'Moonshot',    color: '#16161a', logo: 'assets/kimi.jpg' },
    minimax:     { label: 'MiniMax',     color: '#e8452c' },
    mistralai:   { label: 'Mistral',     color: '#fa520f', logo: 'assets/mistral.png' },
    nvidia:      { label: 'NVIDIA',      color: '#76b900' },
    meta:        { label: 'Meta',        color: '#0668e1' },
    xiaomi:      { label: 'Xiaomi',      color: '#ff6900' },
    tencent:     { label: 'Tencent',     color: '#0052d9' },
    stealth:     { label: 'Stealth',     color: '#6b7280' },
  };

  const VENDOR_ORDER = [
    'z-ai', 'openai', 'anthropic', 'google', 'deepseek', 'qwen',
    'x-ai', 'moonshotai', 'minimax', 'mistralai', 'nvidia', 'meta',
    'xiaomi', 'tencent', 'stealth',
  ];

  // ------------------------------------------------------------- state ---

  const store = {
    get(k, fb) {
      try {
        const v = localStorage.getItem('xkiro.' + k);
        return v === null ? fb : JSON.parse(v);
      } catch { return fb; }
    },
    set(k, v) {
      try { localStorage.setItem('xkiro.' + k, JSON.stringify(v)); } catch {}
    },
    del(k) { try { localStorage.removeItem('xkiro.' + k); } catch {} },
  };

  const state = {
    models: [],
    modelsById: new Map(),
    model: store.get('model', DEFAULT_MODEL),
    threads: store.get('threads', []),
    activeId: store.get('activeId', null),
    apiKey: store.get('apiKey', ''),
    serverKey: false,
    serverKeyShape: null,
    system: store.get('system', 'You are a helpful, precise assistant. Use Markdown for structure and fenced code blocks with a language tag for code.'),
    temperature: store.get('temperature', 0.7),
    maxTokens: store.get('maxTokens', null),
    historyWindow: store.get('historyWindow', 24),
    effort: store.get('effort', 'auto'),
    peek: null,
    webSearch: store.get('webSearch', false),
    theme: store.get('theme', 'dark'),
    incognito: false,
    freeOnly: store.get('freeOnly', false),
    budget: store.get('budget', 5),
    spent: store.get('spent', 0),
    filter: 'all',
    attachments: [],
    streaming: false,
    abort: null,
  };

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const vendorOf = (id) => String(id).split('/')[0];
  const vendorInfo = (id) => VENDORS[vendorOf(id)] || { label: vendorOf(id), color: '#6b7280' };

  function renderSpend(usage) {
    const pill = $('ctxPill');
    const spent = state.spent;
    const budget = Number(state.budget) || 0;
    const left = budget - spent;

    let txt = '';
    if (usage) txt += `${usage.prompt_tokens}↑ ${usage.completion_tokens}↓  `;
    if (budget > 0) {
      txt += `$${left >= 0 ? left.toFixed(4) : '0.0000'} left`;
      const frac = spent / budget;
      pill.className = 'pill' + (frac >= 1 ? ' danger' : frac >= 0.8 ? ' warn' : '');
      pill.title = `Spent $${spent.toFixed(5)} of $${budget.toFixed(2)} this browser. Reset in Settings.`;
    } else if (spent > 0) {
      txt += `$${spent.toFixed(5)} spent`;
      pill.className = 'pill';
    }
    pill.textContent = txt.trim();
  }

  function freeAlternativeHint() {
    const free = state.models.filter(
      (m) => m.access_tier === 'free' || (m.pricing && !m.pricing.input && !m.pricing.output)
    );
    if (!free.length) return 'Top up at xkiro.com/dashboard to unlock it.';
    const best = free
      .slice()
      .sort((a, b) => (b.context_length || 0) - (a.context_length || 0))
      .slice(0, 3)
      .map((m) => m.display_name || m.id);
    return `This account is on the free tier — ${free.length} models cost nothing. ` +
      `Open the model pill and tap the Free filter. Good picks: ${best.join(', ')}.`;
  }

  function modelMeta(id) {
    return state.modelsById.get(id) || {
      id,
      display_name: String(id).split('/').pop(),
      capabilities: { vision: false, tools: false, reasoning: false },
      pricing: null,
      context_length: null,
    };
  }

  function fmtCtx(n) {
    if (!n) return '';
    if (n >= 1e6) return (n / 1e6).toFixed(n % 1e6 ? 1 : 0) + 'M';
    return Math.round(n / 1000) + 'K';
  }

  function fmtPrice(m) {
    const p = m.pricing;
    if (!p) return '';
    if (!p.input && !p.output) return 'free';
    return `$${p.input}/$${p.output}`;
  }

  // ----------------------------------------------------------- threads ---

  function activeThread() {
    return state.threads.find((t) => t.id === state.activeId) || null;
  }

  function newThread() {
    const t = { id: uid(), title: 'New chat', messages: [], model: state.model, createdAt: Date.now(), updatedAt: Date.now() };
    state.threads.unshift(t);
    state.activeId = t.id;
    persist();
    renderThreads();
    renderMessages();
    $('input').focus();
    return t;
  }

  function ensureThread() {
    return activeThread() || newThread();
  }

  function persist() {
    // A temporary chat never touches localStorage.
    if (state.incognito) return;
    // Keep localStorage lean: images are heavy, cap the stored history.
    const slim = state.threads.slice(0, 60).map((t) => ({
      ...t,
      messages: t.messages.slice(-80),
    }));
    store.set('threads', slim);
    store.set('activeId', state.activeId);
  }

  function titleFrom(text) {
    const clean = String(text).replace(/\s+/g, ' ').trim();
    return clean.length > 42 ? clean.slice(0, 42) + '…' : clean || 'New chat';
  }

  function groupLabel(ts) {
    const d = new Date(ts), now = new Date();
    const day = 864e5;
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (ts >= startToday) return 'Today';
    if (ts >= startToday - day) return 'Yesterday';
    if (ts >= startToday - 7 * day) return 'Previous 7 days';
    if (ts >= startToday - 30 * day) return 'Previous 30 days';
    return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  }

  function renderThreads() {
    const list = $('threadList');
    const q = $('threadSearch').value.trim().toLowerCase();
    const items = state.threads
      .filter((t) => !t.temp)
      .filter((t) => !q || t.title.toLowerCase().includes(q) ||
        t.messages.some((m) => String(m.content || '').toLowerCase().includes(q)))
      .sort((a, b) => b.updatedAt - a.updatedAt);

    list.innerHTML = '';
    if (!items.length) {
      list.innerHTML = `<div style="padding:22px 10px;text-align:center;color:var(--text-faint);font-size:12.5px">${q ? 'No matches' : 'No chats yet'}</div>`;
      return;
    }

    let lastGroup = '';
    for (const t of items) {
      const g = groupLabel(t.updatedAt);
      if (g !== lastGroup) {
        lastGroup = g;
        const lbl = document.createElement('div');
        lbl.className = 'thread-group-label';
        lbl.textContent = g;
        list.appendChild(lbl);
      }
      const row = document.createElement('div');
      row.className = 'thread' + (t.id === state.activeId ? ' active' : '');
      row.innerHTML = `<span class="thread-title"></span>
        <button class="thread-del" title="Delete">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>`;
      row.querySelector('.thread-title').textContent = t.title;
      row.addEventListener('click', () => {
        state.activeId = t.id;
        if (t.model && state.modelsById.has(t.model)) setModel(t.model, true);
        persist(); renderThreads(); renderMessages(); closeSidebarOnMobile();
      });
      row.querySelector('.thread-del').addEventListener('click', (e) => {
        e.stopPropagation();
        state.threads = state.threads.filter((x) => x.id !== t.id);
        if (state.activeId === t.id) state.activeId = state.threads[0]?.id || null;
        persist(); renderThreads(); renderMessages();
      });
      list.appendChild(row);
    }
  }

  // ------------------------------------------------------------ models ---

  async function loadModels() {
    try {
      const headers = {};
      if (state.apiKey) headers['X-Xkiro-Key'] = state.apiKey;
      const res = await fetch('/api/models', { headers });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error?.message || `HTTP ${res.status}`);

      state.models = (json.data || []).slice();
      state.modelsById = new Map(state.models.map((m) => [m.id, m]));

      if (!state.modelsById.has(state.model)) {
        state.model = state.modelsById.has(DEFAULT_MODEL)
          ? DEFAULT_MODEL
          : state.models[0]?.id || DEFAULT_MODEL;
      }
      setModel(state.model, true);
      renderModelList();
    } catch (err) {
      $('modelName').textContent = 'GLM-5.3 Flash';
      state.models = [{
        id: DEFAULT_MODEL, display_name: 'GLM-5.3 Flash', access_tier: 'paid',
        capabilities: { vision: true, tools: true, reasoning: true },
        pricing: { input: 0.15, output: 0.5 }, context_length: 1000000,
        reasoning_efforts: { levels: ['low', 'high', 'max'], default: 'low' },
      }];
      state.modelsById = new Map(state.models.map((m) => [m.id, m]));
      setModel(DEFAULT_MODEL, true);
      renderModelList();
    }
  }

  function avatarHTML(id, size) {
    const v = vendorInfo(id);
    if (v.logo) {
      // Marks that are solid black need a light plate, or they vanish on the
      // dark theme. The plate is inset slightly so it reads as part of the icon.
      const plate = v.plate
        ? 'background:#fff;padding:11%;border-radius:26%;'
        : '';
      return `<img src="${v.logo}" alt="${v.label}" style="${plate}width:100%;height:100%;object-fit:contain">`;
    }
    const letter = (v.label[0] || '?').toUpperCase();
    return `<span style="background:${v.color};color:#fff;width:100%;height:100%;display:grid;place-items:center;font-size:${Math.round(size * 0.45)}px">${letter}</span>`;
  }

  function setModel(id, silent) {
    state.model = id;
    store.set('model', id);
    const m = modelMeta(id);
    const v = vendorInfo(id);

    $('modelAvatar').innerHTML = avatarHTML(id, 18);
    $('modelName').textContent = m.display_name || id.split('/').pop();
    $('modelBtn').title = `${m.id}${m.context_length ? ' · ' + fmtCtx(m.context_length) + ' context' : ''}${fmtPrice(m) ? ' · ' + fmtPrice(m) : ''}`;
    $('input').placeholder = `Chat with ${m.display_name || id}…`;
    $('attachBtn').title = m.capabilities?.vision
      ? 'Attach image'
      : `${m.display_name} has no vision input`;
    if (!m.capabilities?.vision && state.attachments.length) {
      state.attachments = [];
      renderAttachments();
    }

    // Reasoning control availability is per model, read from the catalog.
    const levels = m.reasoning_efforts?.levels || null;
    $('thinkBtn').title = levels ? 'Reasoning depth' : `${m.display_name} has no reasoning control`;
    if (levels && !['auto', ...levels].includes(state.effort)) state.effort = 'auto';
    updateThinkPill();

    const t = activeThread();
    if (t && !silent) { t.model = id; persist(); }
    document.querySelectorAll('.model-item').forEach((el) => {
      el.classList.toggle('sel', el.dataset.id === id);
    });
  }

  function updateThinkPill() {
    const m = modelMeta(state.model);
    const levels = m.reasoning_efforts?.levels;
    const active = Boolean(levels) && state.effort !== 'auto';
    $('thinkBtn').classList.toggle('on', active);
    if (active) $('thinkBtn').title = `Reasoning: ${state.effort}`;
  }

  function closeModelMenu() {
    $('modelMenu').classList.remove('open', 'show-detail');
  }

  /**
   * Painel direito: descrição, contexto e — o ponto principal da referência —
   * o controle de raciocínio junto do modelo, em vez de escondido noutro modal.
   * Os níveis vêm do catálogo ao vivo, que é a única fonte confiável.
   */
  function renderModelDetail() {
    const box = $('mmDetail');
    const id = state.peek || state.model;
    const m = modelMeta(id);
    if (!m || !m.id) {
      box.innerHTML = '<div class="mm-empty">Escolha um modelo para ver os detalhes.</div>';
      return;
    }

    const free = m.access_tier === 'free' || (m.pricing && !m.pricing.input && !m.pricing.output);
    const chosen = m.id === state.model;
    const levels = m.reasoning_efforts?.levels || null;

    const facts = [];
    if (m.context_length) facts.push(['Contexto', fmtCtx(m.context_length)]);
    if (m.max_output_tokens) facts.push(['Saída máx.', fmtCtx(m.max_output_tokens)]);
    facts.push(['Preço', free ? 'Grátis' : fmtPrice(m)]);
    facts.push(['Acesso', m.access_tier || '—']);

    box.innerHTML = `
      <div class="mm-head">
        <span class="mm-avatar">${avatarHTML(m.id, 26)}</span>
        <div class="mm-title">
          <strong>${MD.escapeHtml(m.display_name || m.id)}</strong>
          <code>${MD.escapeHtml(m.id)}</code>
        </div>
      </div>
      <div class="mm-badges">
        ${free ? '<span class="badge free">free</span>' : ''}
        ${m.access_tier === 'premium' ? '<span class="badge premium">premium</span>' : ''}
        ${m.capabilities?.vision ? '<span class="badge vision">vision</span>' : ''}
        ${m.capabilities?.tools ? '<span class="badge tool">tools</span>' : ''}
        ${levels ? '<span class="badge think">think</span>' : ''}
      </div>
      <dl class="mm-facts">
        ${facts.map(([k, v]) => `<div><dt>${MD.escapeHtml(k)}</dt><dd>${MD.escapeHtml(String(v))}</dd></div>`).join('')}
      </dl>
      <div class="mm-section" id="mmEffortWrap"></div>
      <button class="mm-use${chosen ? ' is-current' : ''}" id="mmUse">
        ${chosen ? 'Modelo atual' : 'Usar este modelo'}
      </button>`;

    const wrap = $('mmEffortWrap');
    if (levels) {
      wrap.innerHTML = `<div class="mm-label">Esforço</div>`;
      const list = document.createElement('div');
      list.className = 'mm-efforts';
      ['auto', ...levels].forEach((lv) => {
        const b = document.createElement('button');
        b.className = 'mm-effort' + (state.effort === lv ? ' on' : '');
        const label = lv === 'auto' ? 'Automático' : lv;
        b.innerHTML = `<span>${MD.escapeHtml(label)}</span>` +
          (state.effort === lv
            ? '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>'
            : '');
        b.addEventListener('click', () => {
          state.effort = lv;
          store.set('effort', lv);
          updateThinkPill();
          renderModelDetail();
        });
        list.appendChild(b);
      });
      wrap.appendChild(list);
      const note = document.createElement('p');
      note.className = 'mm-note';
      note.textContent = `Padrão do modelo: ${m.reasoning_efforts.default ?? 'nenhum'}. "Automático" não envia o campo — o que não é o mesmo que desligar.`;
      wrap.appendChild(note);
    } else {
      wrap.innerHTML = '<p class="mm-note">Este modelo ignora controle de raciocínio.</p>';
    }

    $('mmUse').addEventListener('click', () => {
      setModel(m.id);
      closeModelMenu();
    });
  }

  function renderModelList() {
    const q = $('modelSearch').value.trim().toLowerCase();
    const wrap = $('modelList');
    let list = state.models.slice();
    if (state.freeOnly) {
      list = list.filter((m) => m.access_tier === 'free' || (m.pricing && !m.pricing.input && !m.pricing.output));
    }

    if (state.filter === 'free') list = list.filter((m) => m.access_tier === 'free' || (m.pricing && !m.pricing.input && !m.pricing.output));
    else if (state.filter === 'vision') list = list.filter((m) => m.capabilities?.vision);
    else if (state.filter === 'reasoning') list = list.filter((m) => m.capabilities?.reasoning);
    else if (state.filter === 'cheap') {
      list = list
        .filter((m) => m.pricing)
        .sort((a, b) => (a.pricing.input + a.pricing.output) - (b.pricing.input + b.pricing.output))
        .slice(0, 25);
    } else if (VENDORS[state.filter]) list = list.filter((m) => vendorOf(m.id) === state.filter);

    if (q) {
      list = list.filter((m) =>
        m.id.toLowerCase().includes(q) ||
        String(m.display_name || '').toLowerCase().includes(q) ||
        vendorInfo(m.id).label.toLowerCase().includes(q)
      );
    }

    wrap.innerHTML = '';
    if (!list.length) {
      wrap.innerHTML = '<div style="padding:26px;text-align:center;color:var(--text-faint);font-size:13px">No models match</div>';
      return;
    }

    const grouped = new Map();
    for (const m of list) {
      const v = vendorOf(m.id);
      if (!grouped.has(v)) grouped.set(v, []);
      grouped.get(v).push(m);
    }
    const order = [...grouped.keys()].sort((a, b) => {
      const ia = VENDOR_ORDER.indexOf(a), ib = VENDOR_ORDER.indexOf(b);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });

    for (const v of order) {
      if (state.filter !== 'cheap') {
        const lbl = document.createElement('div');
        lbl.className = 'model-vendor-label';
        lbl.textContent = (VENDORS[v]?.label || v) + ` · ${grouped.get(v).length}`;
        wrap.appendChild(lbl);
      }
      for (const m of grouped.get(v)) {
        const free = m.access_tier === 'free' || (m.pricing && !m.pricing.input && !m.pricing.output);
        const btn = document.createElement('button');
        btn.className = 'model-item' + (m.id === state.model ? ' sel' : '') + (m.id === state.peek ? ' peek' : '');
        btn.dataset.id = m.id;
        btn.innerHTML = `
          <span class="model-avatar">${avatarHTML(m.id, 22)}</span>
          <span class="model-item-main">
            <span class="model-item-name">
              ${MD.escapeHtml(m.display_name || m.id)}
              ${free ? '<span class="badge free">free</span>' : ''}
              ${m.access_tier === 'premium' ? '<span class="badge premium">premium</span>' : ''}
              ${m.capabilities?.vision ? '<span class="badge vision">vision</span>' : ''}
              ${m.reasoning_efforts ? '<span class="badge think">think</span>' : ''}
            </span>
            <span class="model-item-meta">${MD.escapeHtml(m.id)}${m.context_length ? ' · ' + fmtCtx(m.context_length) : ''}</span>
          </span>
          <span class="model-price">${free ? '' : MD.escapeHtml(fmtPrice(m))}</span>`;
        btn.addEventListener('click', () => {
          // Um toque foca o modelo no painel de detalhes; o segundo confirma.
          // Em telas estreitas o painel vira uma segunda "página" do menu.
          if (state.peek === m.id) {
            setModel(m.id);
            closeModelMenu();
          } else {
            state.peek = m.id;
            renderModelList();
            renderModelDetail();
            if (window.matchMedia('(max-width: 720px)').matches) {
              $('modelMenu').classList.add('show-detail');
            }
          }
        });
        wrap.appendChild(btn);
      }
    }
  }

  // ---------------------------------------------------------- messages ---

  function HERO_GREETING() {
    const h = new Date().getHours();
    if (state.incognito) return 'Temporary chat';
    if (h < 5) return 'Burning the midnight oil';
    if (h < 12) return 'Good morning';
    if (h < 18) return 'Good afternoon';
    return 'Good evening';
  }

  const SUGGESTIONS = [
    { t: 'Explain a hard idea', d: 'Break down how HTTP caching actually works', p: 'Explain how HTTP caching works — Cache-Control, ETag and revalidation — with a concrete example of each header in action.' },
    { t: 'Write code', d: 'A rate limiter with tests', p: 'Write a token-bucket rate limiter in TypeScript. Include the class, a small usage example, and unit tests. Explain the trade-offs against a sliding window.' },
    { t: 'Compare options', d: 'Which model should I use?', p: 'I am building a customer-support chatbot that handles about 50,000 messages a day. Compare a cheap flash-tier model against a flagship one for this job, and tell me how to decide with evidence rather than vibes.' },
    { t: 'Draft something', d: 'A clear release note', p: 'Draft release notes for a version that adds streaming responses, an image attachment feature, and fixes a bug where long conversations lost the system prompt. Keep it short and readable.' },
  ];

  function renderMessages() {
    const box = $('messages');
    const t = activeThread();
    box.innerHTML = '';

    if (!t || !t.messages.length) {
      const m = modelMeta(state.model);
      const empty = document.createElement('div');
      empty.innerHTML = `
        <div class="hero">
          <svg class="hero-mark" viewBox="0 0 100 100"><use href="#burst"/></svg>
          <h1>${MD.escapeHtml(HERO_GREETING())}</h1>
          <p>${MD.escapeHtml(m.display_name || state.model)}${m.context_length ? ' · ' + fmtCtx(m.context_length) + ' context' : ''}${state.incognito ? ' · temporary chat' : ''}</p>
        </div>
        <div class="suggestions"></div>`;
      const sg = empty.querySelector('.suggestions');
      SUGGESTIONS.forEach((sug) => {
        const b = document.createElement('button');
        b.className = 'suggestion';
        b.innerHTML = `<div class="suggestion-t">${MD.escapeHtml(sug.t)}</div><div class="suggestion-d">${MD.escapeHtml(sug.d)}</div>`;
        b.addEventListener('click', () => {
          $('input').value = sug.p;
          autosize(); updateSend(); send();
        });
        sg.appendChild(b);
      });
      box.appendChild(empty);
      return;
    }

    t.messages.forEach((msg, i) => box.appendChild(messageEl(msg, i)));
    scrollDown(true);
  }

  function messageEl(msg, index) {
    const el = document.createElement('div');
    el.className = 'msg ' + msg.role;
    el.dataset.index = index;

    const isUser = msg.role === 'user';
    const mid = msg.model || state.model;
    const meta = modelMeta(mid);

    const avatar = document.createElement('div');
    avatar.className = 'msg-avatar';
    avatar.innerHTML = isUser
      ? '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M5.5 21a6.5 6.5 0 0 1 13 0"/></svg>'
      : avatarHTML(mid, 29);

    const body = document.createElement('div');
    body.className = 'msg-body';

    const name = document.createElement('div');
    name.className = 'msg-name';
    name.innerHTML = isUser
      ? 'You'
      : `${MD.escapeHtml(meta.display_name || mid)}<span class="tag">${MD.escapeHtml(mid)}</span>`;
    body.appendChild(name);

    if (msg.images?.length) {
      const strip = document.createElement('div');
      strip.className = 'msg-attachments';
      msg.images.forEach((src) => {
        const img = document.createElement('img');
        img.src = src;
        strip.appendChild(img);
      });
      body.appendChild(strip);
    }

    if (msg.reasoning) body.appendChild(reasoningEl(msg.reasoning, false));

    const content = document.createElement('div');
    content.className = 'msg-content md';
    if (msg.error) {
      content.innerHTML = `<div class="err-box"><b>Request failed.</b> ${
        MD.escapeHtml(msg.content).replace(/`([^`]+)`/g, '<code>$1</code>')
      }</div>`;
    } else if (isUser) {
      content.innerHTML = `<p>${MD.escapeHtml(msg.content).replace(/\n/g, '<br>')}</p>`;
    } else {
      content.innerHTML = MD.render(msg.content || '');
    }
    body.appendChild(content);

    if (msg.searching) {
      const s = document.createElement('div');
      s.className = 'searching';
      s.innerHTML = '<span class="dot"></span> Searching the web\u2026';
      body.appendChild(s);
    }
    if (msg.searchNote) {
      const n = document.createElement('div');
      n.className = 'search-note';
      n.textContent = msg.searchNote;
      body.appendChild(n);
    }
    if (msg.sources?.length) body.appendChild(sourcesEl(msg));

    if (!state.streaming) body.appendChild(actionsEl(msg, index));

    el.appendChild(avatar);
    el.appendChild(body);
    return el;
  }

  function reasoningEl(text, open) {
    const d = document.createElement('details');
    d.className = 'reasoning';
    if (open) d.open = true;
    d.innerHTML = `<summary>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2a7 7 0 0 0-4 12.7V17a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2v-2.3A7 7 0 0 0 12 2zM9 22h6"/></svg>
        Reasoning
      </summary><div class="reasoning-body"></div>`;
    d.querySelector('.reasoning-body').textContent = text;
    return d;
  }

  function sourcesEl(msg) {
    const d = document.createElement('details');
    d.className = 'sources';
    const via = msg.searchProviders?.length ? ` \u00b7 via ${msg.searchProviders.join(' + ')}` : '';
    d.innerHTML =
      `<summary>${msg.sources.length} web source${msg.sources.length > 1 ? 's' : ''}${MD.escapeHtml(via)}</summary>` +
      '<ol>' +
      msg.sources
        .map((x) => {
          const t = MD.escapeHtml(x.title || x.url || 'Untitled');
          const head = x.url
            ? `<a href="${MD.escapeHtml(x.url)}" target="_blank" rel="noopener">${t}</a>`
            : t;
          return `<li>${head}<span>${MD.escapeHtml((x.snippet || '').slice(0, 190))}</span></li>`;
        })
        .join('') +
      '</ol>';
    return d;
  }

  function actionsEl(msg, index) {
    const wrap = document.createElement('div');
    wrap.className = 'msg-actions';

    const copy = document.createElement('button');
    copy.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg> Copy`;
    copy.addEventListener('click', () => copyText(msg.content || ''));
    wrap.appendChild(copy);

    if (msg.role === 'assistant') {
      const retry = document.createElement('button');
      retry.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M20 12a8 8 0 1 1-2.6-5.9M20 4v5h-5"/></svg> Retry`;
      retry.addEventListener('click', () => regenerate(index));
      wrap.appendChild(retry);
    }
    if (msg.role === 'user') {
      const edit = document.createElement('button');
      edit.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg> Edit`;
      edit.addEventListener('click', () => {
        const t = activeThread();
        $('input').value = msg.content;
        t.messages = t.messages.slice(0, index);
        persist(); renderMessages(); autosize(); updateSend(); $('input').focus();
      });
      wrap.appendChild(edit);
    }
    return wrap;
  }

  function scrollDown(force) {
    const a = $('scrollArea');
    const near = a.scrollHeight - a.scrollTop - a.clientHeight < 190;
    if (force || near) a.scrollTop = a.scrollHeight;
  }

  // ------------------------------------------------------------- send ----

  function buildPayloadMessages(thread, upto) {
    const msgs = [];
    if (state.system.trim()) msgs.push({ role: 'system', content: state.system.trim() });

    const history = thread.messages
      .slice(0, upto == null ? thread.messages.length : upto)
      .filter((m) => !m.error)
      .slice(-Math.max(2, state.historyWindow));

    for (const m of history) {
      if (m.role === 'user' && m.images?.length && modelMeta(state.model).capabilities?.vision) {
        const parts = [];
        if (m.content) parts.push({ type: 'text', text: m.content });
        m.images.forEach((url) => parts.push({ type: 'image_url', image_url: { url } }));
        msgs.push({ role: 'user', content: parts });
      } else {
        msgs.push({ role: m.role, content: m.content });
      }
      if (m.role === 'user' && m.sources?.length) {
        const block = m.sources
          .map((x, i) => `[${i + 1}] ${x.title}\n${x.snippet}${x.url ? `\nSource: ${x.url}` : ''}`)
          .join('\n\n');
        msgs.push({
          role: 'system',
          content:
            'Web search results for the previous question. Use them if relevant and cite as [1], [2]. ' +
            'If they do not answer it, say so rather than guessing.\n\n' + block,
        });
      }
    }
    return msgs;
  }

  async function send() {
    if (state.streaming) return;
    const text = $('input').value.trim();
    if (!text && !state.attachments.length) return;

    const t = ensureThread();
    const userMsg = { role: 'user', content: text, images: state.attachments.slice(), ts: Date.now() };
    t.messages.push(userMsg);
    if (t.messages.length === 1 || t.title === 'New chat') t.title = titleFrom(text || 'Image');
    t.model = state.model;
    t.updatedAt = Date.now();

    $('input').value = '';
    state.attachments = [];
    renderAttachments();
    autosize();
    updateSend();
    renderSpend(null);
    persist();
    renderThreads();
    renderMessages();

    // Web lookup happens BEFORE the model call, and its findings ride along as
    // context on the user's message. Failure is never fatal: if the lookup
    // fails the question is still asked, just without sources.
    if (state.webSearch && text) {
      userMsg.searching = true;
      renderMessages();
      try {
        const r = await fetch('/api/search?q=' + encodeURIComponent(text));
        const j = await r.json();
        if (j.ok && j.results?.length) {
          userMsg.sources = j.results.slice(0, 5).map((x) => ({
            title: x.title, url: x.url, snippet: x.snippet,
          }));
          userMsg.searchProviders = j.sources || [];
        } else {
          userMsg.searchNote = 'No web results found.';
        }
      } catch {
        userMsg.searchNote = 'Web search unavailable — answering without it.';
      }
      userMsg.searching = false;
      persist();
      renderMessages();
    }

    await stream(t);
  }

  async function regenerate(index) {
    const t = activeThread();
    if (!t || state.streaming) return;
    t.messages = t.messages.slice(0, index);
    persist();
    renderMessages();
    await stream(t);
  }

  async function stream(thread) {
    state.streaming = true;
    updateSend();

    const modelId = state.model;
    const assistant = { role: 'assistant', content: '', reasoning: '', model: modelId, ts: Date.now() };
    thread.messages.push(assistant);

    // Live DOM nodes we append tokens into.
    const el = messageEl(assistant, thread.messages.length - 1);
    const contentEl = el.querySelector('.msg-content');
    contentEl.innerHTML = '<div class="typing"><i></i><i></i><i></i></div>';
    $('messages').appendChild(el);
    scrollDown(true);

    let reasoningNode = null;
    let reasoningBody = null;
    let raf = 0;
    const paint = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        contentEl.innerHTML = MD.render(assistant.content) + (state.streaming ? '<span class="typing"><i></i></span>' : '');
        scrollDown(false);
      });
    };

    state.abort = new AbortController();

    const body = {
      model: modelId,
      messages: buildPayloadMessages(thread, thread.messages.length - 1),
      temperature: state.temperature,
    };
    if (state.maxTokens) body.max_tokens = state.maxTokens;
    const levels = modelMeta(modelId).reasoning_efforts?.levels;
    if (levels && state.effort !== 'auto') body.reasoning_effort = state.effort;

    let usage = null;
    let failed = null;

    try {
      const headers = { 'Content-Type': 'application/json' };
      if (state.apiKey) headers['X-Xkiro-Key'] = state.apiKey;

      let res;
      try {
        res = await fetch('/api/chat', {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: state.abort.signal,
        });
      } catch (netErr) {
        if (netErr.name === 'AbortError') throw netErr;
        throw new Error(SERVER_DOWN_HINT);
      }

      if (!res.ok || !res.body) {
        let msg = `HTTP ${res.status}`;
        let j = null;
        try { j = await res.json(); } catch {}
        if (res.status === 403 || j?.error?.code === 'permission_denied') {
          msg = (j?.error?.message || 'Your account cannot call this model.') +
            ' ' + freeAlternativeHint();
        } else if (res.status === 401) {
          msg = (j?.error?.message || 'Unauthorized.') +
            ' Check the key in Settings — keys start with `sk-xt-`.';
        } else if (res.status === 429) {
          msg = (j?.error?.message || 'Rate limited.') +
            ' Wait a moment and resend, or switch to a less busy model.';
        } else if (j?.error?.message) {
          msg = j.error.message;
        } else if (res.status === 405 || res.status === 502 || res.status === 503 || res.status === 504) {
          // Our own server always answers /api/chat with JSON. A bare 405/50x
          // means the request never reached it — the process is not running.
          msg = SERVER_DOWN_HINT;
        }
        throw new Error(msg);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let done = false;

      while (!done) {
        const { done: fin, value } = await reader.read();
        if (fin) break;
        buffer += decoder.decode(value, { stream: true });

        // Events are separated by a blank line; a chunk boundary can land
        // mid-event, so the tail is kept for the next round.
        const events = buffer.split('\n\n');
        buffer = events.pop() ?? '';

        for (const evt of events) {
          const line = evt.split('\n').find((l) => l.startsWith('data:'));
          if (!line) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') { done = true; break; }

          let json;
          try { json = JSON.parse(payload); } catch { continue; }

          // Errors arrive as frames once the status is already 200.
          if (json.error) throw new Error(json.error.message || 'Upstream error');

          // Usage rides in its own frame with an EMPTY choices array —
          // never index choices[0] unconditionally.
          if (json.usage) usage = json.usage;

          const delta = json.choices?.[0]?.delta;
          if (!delta) continue;

          const think = delta.reasoning_content ?? delta.reasoning;
          if (think) {
            assistant.reasoning += think;
            if (!reasoningNode) {
              reasoningNode = reasoningEl('', true);
              reasoningBody = reasoningNode.querySelector('.reasoning-body');
              contentEl.parentNode.insertBefore(reasoningNode, contentEl);
            }
            reasoningBody.textContent = assistant.reasoning;
            reasoningBody.scrollTop = reasoningBody.scrollHeight;
            scrollDown(false);
          }
          if (delta.content) {
            assistant.content += delta.content;
            paint();
          }
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        assistant.content += assistant.content ? '\n\n_(stopped)_' : '_(stopped)_';
      } else {
        failed = err.message || String(err);
      }
    } finally {
      state.streaming = false;
      state.abort = null;
      if (raf) cancelAnimationFrame(raf);

      if (failed) {
        assistant.error = true;
        assistant.content = failed;
      }
      if (!assistant.content && !assistant.error) {
        assistant.error = true;
        assistant.content = 'The model returned an empty response. Try again, or pick another model.';
      }
      if (assistant.reasoning) {
        // collapse it once the answer exists
        assistant.reasoning = assistant.reasoning.trim();
      }
      if (usage) assistant.usage = usage;

      thread.updatedAt = Date.now();
      persist();
      renderThreads();
      renderMessages();
      updateSend();

      if (usage) {
        const m = modelMeta(modelId);
        if (m.pricing && (m.pricing.input || m.pricing.output)) {
          const c = (usage.prompt_tokens / 1e6) * m.pricing.input +
                    (usage.completion_tokens / 1e6) * m.pricing.output;
          state.spent += c;
          store.set('spent', state.spent);
        }
        renderSpend(usage);
      }
    }
  }

  function stop() {
    if (state.abort) state.abort.abort();
  }

  // ------------------------------------------------------- attachments ---

  function renderAttachments() {
    const strip = $('attachStrip');
    strip.innerHTML = '';
    state.attachments.forEach((src, i) => {
      const d = document.createElement('div');
      d.className = 'attach-thumb';
      d.innerHTML = `<img src="${src}" alt=""><button class="attach-x" title="Remove">×</button>`;
      d.querySelector('.attach-x').addEventListener('click', () => {
        state.attachments.splice(i, 1);
        renderAttachments();
        updateSend();
      });
      strip.appendChild(d);
    });
  }

  function addFiles(files) {
    const m = modelMeta(state.model);
    if (!m.capabilities?.vision) return toast(`${m.display_name} does not accept images`);
    [...files].filter((f) => f.type.startsWith('image/')).slice(0, 6).forEach((f) => {
      if (f.size > 8 * 1024 * 1024) return toast(`${f.name} is over 8 MB`);
      const r = new FileReader();
      r.onload = () => {
        state.attachments.push(r.result);
        renderAttachments();
        updateSend();
      };
      r.readAsDataURL(f);
    });
  }

  // ------------------------------------------------------------- misc ----

  function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), 2100);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied');
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); toast('Copied'); } catch { toast('Copy failed'); }
      ta.remove();
    }
  }

  function autosize() {
    const ta = $('input');
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 240) + 'px';
  }

  function updateSend() {
    const btn = $('sendBtn');
    const hasText = $('input').value.trim().length > 0 || state.attachments.length > 0;
    if (state.streaming) {
      btn.disabled = false;
      btn.classList.add('stop');
      btn.title = 'Stop generating';
      btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="2.5"/></svg>';
    } else {
      btn.disabled = !hasText;
      btn.classList.remove('stop');
      btn.title = 'Send';
      btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
    }
  }

  function applyTheme() {
    document.documentElement.dataset.theme = state.theme;
    $('themeLabel').textContent = state.theme === 'dark' ? 'Light' : 'Dark';
  }

  function closeSidebarOnMobile() {
    if (window.innerWidth <= 820) {
      $('sidebar').classList.add('collapsed');
      $('scrim').classList.remove('on');
    }
  }

  function openThinkModal() {
    const m = modelMeta(state.model);
    const levels = m.reasoning_efforts?.levels;
    if (!levels) return;
    // O esforço agora vive junto do modelo, como na referência: abrir o menu
    // já focado no modelo atual evita dois lugares diferentes para a mesma opção.
    state.peek = state.model;
    $('modelMenu').classList.add('open');
    renderModelList();
    renderModelDetail();
    if (window.matchMedia('(max-width: 720px)').matches) $('modelMenu').classList.add('show-detail');
    return;
    const body = $('thinkBody');
    body.innerHTML = `<p class="desc" style="margin:0 0 12px">
      <strong>${MD.escapeHtml(m.display_name)}</strong> accepts:
      <code>${levels.map(MD.escapeHtml).join('</code>, <code>')}</code>.
      Its own default is <code>${MD.escapeHtml(m.reasoning_efforts.default ?? 'unset')}</code>.
      Omitting the field is not the same as switching reasoning off.
    </p>`;
    const opts = ['auto', ...levels];
    const grid = document.createElement('div');
    grid.style.cssText = 'display:flex;flex-direction:column;gap:6px';
    opts.forEach((lv) => {
      const b = document.createElement('button');
      b.className = 'model-item' + (state.effort === lv ? ' sel' : '');
      const note = lv === 'auto'
        ? "Send nothing — the model uses its own default"
        : lv === 'none' || lv === 'off' || lv === 'disabled'
          ? 'Explicitly off'
          : `Reasoning effort: ${lv}`;
      b.innerHTML = `<span class="model-item-main"><span class="model-item-name">${MD.escapeHtml(lv)}</span><span class="model-item-meta">${MD.escapeHtml(note)}</span></span>`;
      b.addEventListener('click', () => {
        state.effort = lv;
        store.set('effort', lv);
        updateThinkPill();
        $('thinkOverlay').classList.remove('open');
      });
      grid.appendChild(b);
    });
    body.appendChild(grid);
    $('thinkOverlay').classList.add('open');
  }

  function openSettings() {
    $('apiKeyInput').value = state.apiKey;
    $('budgetInput').value = state.budget;
    $('spentNote').textContent = `Spent so far: $${state.spent.toFixed(5)}`;
    $('freeOnlyInput').checked = state.freeOnly;
    $('systemInput').value = state.system;
    $('tempInput').value = state.temperature;
    $('tempVal').textContent = Number(state.temperature).toFixed(2);
    $('maxTokInput').value = state.maxTokens || '';
    $('historyInput').value = state.historyWindow;
    // Be explicit about WHICH key will actually be used. A stale key saved in
    // the browser silently wins over a perfectly good one in .env, which looks
    // exactly like ".env is being ignored".
    if (state.apiKey) {
      $('keyStatus').innerHTML = state.serverKey
        ? '<strong style="color:var(--warn)">This browser has its own key saved, and it overrides the one in your <code>.env</code>.</strong> If you are seeing authentication errors, clear it below to fall back to the server key.'
        : 'Using the key saved in this browser. It is stored on this device only and never leaves it except to reach xKiro.';
    } else {
      $('keyStatus').innerHTML = state.serverKey
        ? 'Using the key from your <code>.env</code> file on the server. Leave this blank to keep doing that.'
        : '<strong style="color:var(--warn)">No key anywhere.</strong> Paste one here (stored in this browser), or set <code>XKIRO_API_KEY</code> in <code>.env</code> and restart.';
    }
    if (state.serverKeyShape) {
      $('keyStatus').innerHTML +=
        `<br><strong style="color:var(--warn)">Problem with the key in .env:</strong> ${MD.escapeHtml(state.serverKeyShape)}`;
    }
    $('keyTestResult').textContent = '';
    $('settingsOverlay').classList.add('open');
  }

  // ------------------------------------------------------------- wiring --

  function wire() {
    $('newChatBtn').addEventListener('click', () => { newThread(); closeSidebarOnMobile(); });
    $('threadSearch').addEventListener('input', renderThreads);

    $('menuBtn').addEventListener('click', () => {
      const sb = $('sidebar');
      sb.classList.toggle('collapsed');
      $('scrim').classList.toggle('on', !sb.classList.contains('collapsed') && window.innerWidth <= 820);
    });
    $('scrim').addEventListener('click', closeSidebarOnMobile);

    $('incognitoBtn').addEventListener('click', () => {
      state.incognito = !state.incognito;
      $('incognitoBtn').classList.toggle('on', state.incognito);
      if (state.incognito) {
        // start a throwaway thread that is never written to storage
        state.threads.unshift({ id: uid(), title: 'Temporary chat', messages: [], model: state.model, createdAt: Date.now(), updatedAt: Date.now(), temp: true });
        state.activeId = state.threads[0].id;
        toast('Temporary chat — not saved');
      } else {
        state.threads = state.threads.filter((t) => !t.temp);
        state.activeId = state.threads[0]?.id || null;
        toast('Back to saved chats');
        persist();
      }
      renderThreads(); renderMessages();
    });

    $('themeBtn').addEventListener('click', () => {
      state.theme = state.theme === 'dark' ? 'light' : 'dark';
      store.set('theme', state.theme);
      applyTheme();
    });

    // model menu
    $('modelBtn').addEventListener('click', (e) => {
      e.stopPropagation();
      const open = $('modelMenu').classList.toggle('open');
      if (open) {
        $('modelSearch').value = '';
        state.peek = state.model;
        $('modelMenu').classList.remove('show-detail');
        renderModelList();
        renderModelDetail();
        if (!window.matchMedia('(max-width: 720px)').matches) $('modelSearch').focus();
      } else {
        closeModelMenu();
      }
    });
    $('modelSearch').addEventListener('input', renderModelList);
    $('mmClose').addEventListener('click', (e) => {
      e.stopPropagation();
      if ($('modelMenu').classList.contains('show-detail')) $('modelMenu').classList.remove('show-detail');
      else closeModelMenu();
    });
    $('modelMenu').addEventListener('click', (e) => e.stopPropagation());
    $('modelFilters').addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      state.filter = chip.dataset.filter;
      document.querySelectorAll('#modelFilters .chip').forEach((c) => c.classList.toggle('on', c === chip));
      renderModelList();
    });
    document.addEventListener('click', () => closeModelMenu());

    // composer
    const ta = $('input');
    ta.addEventListener('input', () => { autosize(); updateSend(); });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        if (state.streaming) return;
        send();
      }
    });
    ta.addEventListener('paste', (e) => {
      const imgs = [...(e.clipboardData?.items || [])]
        .filter((i) => i.type.startsWith('image/'))
        .map((i) => i.getAsFile())
        .filter(Boolean);
      if (imgs.length) { e.preventDefault(); addFiles(imgs); }
    });

    $('sendBtn').addEventListener('click', () => (state.streaming ? stop() : send()));
    $('attachBtn').addEventListener('click', () => {
      const m = modelMeta(state.model);
      if (!m.capabilities?.vision) return toast(`${m.display_name} does not accept images`);
      $('fileInput').click();
    });
    $('fileInput').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
    $('searchBtn').addEventListener('click', () => {
      state.webSearch = !state.webSearch;
      store.set('webSearch', state.webSearch);
      $('searchBtn').classList.toggle('on', state.webSearch);
      $('searchBtn').title = state.webSearch
        ? 'Web search on — DuckDuckGo, falling back to Wikipedia'
        : 'Search the web before answering';
      toast(state.webSearch ? 'Web search on' : 'Web search off');
    });

    $('thinkBtn').addEventListener('click', () => {
      const m = modelMeta(state.model);
      if (!m.reasoning_efforts?.levels) return toast(`${m.display_name} has no reasoning control`);
      openThinkModal();
    });

    // drag & drop
    ['dragover', 'drop'].forEach((ev) =>
      document.addEventListener(ev, (e) => {
        e.preventDefault();
        if (ev === 'drop' && e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
      })
    );

    // copy buttons inside rendered markdown
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('.md-copy');
      if (!btn) return;
      copyText(decodeURIComponent(btn.dataset.code || ''));
      btn.textContent = 'Copied';
      setTimeout(() => (btn.textContent = 'Copy'), 1400);
    });

    // settings
    $('settingsBtn').addEventListener('click', openSettings);
    $('tempInput').addEventListener('input', (e) => {
      $('tempVal').textContent = Number(e.target.value).toFixed(2);
    });
    $('saveSettings').addEventListener('click', () => {
      const oldKey = state.apiKey;
      state.apiKey = $('apiKeyInput').value.trim();
      const bg = parseFloat($('budgetInput').value);
      state.budget = Number.isFinite(bg) && bg >= 0 ? bg : 0;
      store.set('budget', state.budget);
      state.freeOnly = $('freeOnlyInput').checked;
      store.set('freeOnly', state.freeOnly);
      state.system = $('systemInput').value;
      state.temperature = Number($('tempInput').value);
      const mt = parseInt($('maxTokInput').value, 10);
      state.maxTokens = Number.isFinite(mt) && mt > 0 ? mt : null;
      const hw = parseInt($('historyInput').value, 10);
      state.historyWindow = Number.isFinite(hw) ? Math.max(2, Math.min(200, hw)) : 24;

      store.set('apiKey', state.apiKey);
      store.set('system', state.system);
      store.set('temperature', state.temperature);
      store.set('maxTokens', state.maxTokens);
      store.set('historyWindow', state.historyWindow);

      $('settingsOverlay').classList.remove('open');
      toast('Settings saved');
      renderModelList();
      renderSpend(null);
      if (state.apiKey !== oldKey) loadModels();
    });
    // Prove the key really works. The catalog endpoint is public on xKiro, so
    // a full model list is NOT evidence of a valid key — only a real call is.
    $('testKeyBtn').addEventListener('click', async () => {
      const out = $('keyTestResult');
      const typed = $('apiKeyInput').value.trim();
      out.style.color = '';
      out.textContent = 'Testing…';
      try {
        const headers = {};
        if (typed) {
          headers['X-Xkiro-Key'] = typed;
          // Distinguish "typed but unsaved" from "saved", so the result never
          // points the user at the wrong place to go fix it.
          headers['X-Xkiro-Key-Origin'] = typed === state.apiKey ? 'saved' : 'typed';
        }
        const r = await fetch('/api/verify', { headers });
        const j = await r.json();
        if (j.ok && j.limited) {
          out.style.color = 'var(--warn)';
          out.textContent = `Key is valid (${j.masked}), but: ${j.message}`;
        } else if (j.ok) {
          out.style.color = 'var(--ok, #4ade80)';
          out.textContent = `Works — using ${j.source || 'this key'} (${j.masked}).`;
        } else if (j.shape) {
          out.style.color = 'var(--warn)';
          out.textContent = `${j.message} — ${j.shape}`;
        } else {
          out.style.color = 'var(--warn)';
          const where = j.source ? ` (tried ${j.source})` : '';
          out.innerHTML = MD.escapeHtml(j.message + where) +
            (j.verdict ? `<br><br>${MD.escapeHtml(j.verdict)}` : '') +
            (j.keysUrl
              ? `<br><a href="${j.keysUrl}" target="_blank" rel="noopener" style="color:var(--accent)">Get a new key →</a>`
              : '');
        }
      } catch (e) {
        out.style.color = 'var(--warn)';
        out.textContent = `Could not reach the server — ${e.message}`;
      }
    });

    $('clearKeyBtn').addEventListener('click', () => {
      $('apiKeyInput').value = '';
      state.apiKey = '';
      store.set('apiKey', '');
      $('keyTestResult').style.color = '';
      $('keyTestResult').textContent = state.serverKey
        ? 'Cleared. Now falling back to the key in your .env file.'
        : 'Cleared. There is no key on the server either — paste one above.';
      openSettings();
      loadModels();
    });

    $('resetSpendBtn').addEventListener('click', () => {
      state.spent = 0;
      store.set('spent', 0);
      $('spentNote').textContent = 'Spent so far: $0.00000';
      renderSpend(null);
      toast('Spend counter reset');
    });

    $('wipeBtn').addEventListener('click', () => {
      if (!confirm('Delete every chat in this browser? This cannot be undone.')) return;
      state.threads = [];
      state.activeId = null;
      persist(); renderThreads(); renderMessages();
      $('settingsOverlay').classList.remove('open');
      toast('All chats deleted');
    });

    document.querySelectorAll('[data-close-modal]').forEach((b) =>
      b.addEventListener('click', () => b.closest('.overlay').classList.remove('open'))
    );
    document.querySelectorAll('.overlay').forEach((o) =>
      o.addEventListener('click', (e) => { if (e.target === o) o.classList.remove('open'); })
    );

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        document.querySelectorAll('.overlay.open').forEach((o) => o.classList.remove('open'));
        if ($('modelMenu').classList.contains('show-detail')) $('modelMenu').classList.remove('show-detail');
        else closeModelMenu();
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        $('modelBtn').click();
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        newThread();
      }
    });

    window.addEventListener('resize', () => {
      if (window.innerWidth > 820) $('scrim').classList.remove('on');
    });
  }

  // -------------------------------------------------------------- init ---

  async function init() {
    applyTheme();
    wire();
    $('searchBtn').classList.toggle('on', state.webSearch);
    if (state.webSearch) $('searchBtn').title = 'Web search on — DuckDuckGo, falling back to Wikipedia';
    if (window.innerWidth <= 820) $('sidebar').classList.add('collapsed');

    try {
      const h = await (await fetch('/api/health')).json();
      state.serverKey = Boolean(h.serverKeyConfigured);
      state.serverKeyShape = h.serverKeyShape || null;
    } catch {}

    await loadModels();
    renderThreads();
    renderMessages();
    autosize();
    updateSend();
    renderSpend(null);

    if (!state.serverKey && !state.apiKey) {
      setTimeout(openSettings, 400);
    }
  }

  init();
})();
