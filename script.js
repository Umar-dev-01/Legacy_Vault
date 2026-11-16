/* Amanah · front-end logic
   ------------------------------------------------------------------
   GO LIVE: paste your Google Apps Script web app URL into API_URL.
   While API_URL is empty the site runs as a demo: nothing is sent,
   and emails appear in the demo outbox under "My will".
   ------------------------------------------------------------------ */
(function () {
  'use strict';

  const CONFIG = {
    API_URL: '', // e.g. 'https://script.google.com/macros/s/XXXXXXXX/exec'
    CHECK_IN_DAYS: 90,
    REMINDER_DAYS: [15, 1],
    PENDING_EXPIRY_DAYS: 7,
    MAX_RECIPIENTS: 10,
    MAX_MESSAGE: 15000,
    MAX_NOTE: 1500,
  };

  const DAY = 86400000;
  const DEMO = !CONFIG.API_URL;

  /* ================= helpers ================= */
  const $ = (sel, el) => (el || document).querySelector(sel);
  const $$ = (sel, el) => Array.from((el || document).querySelectorAll(sel));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const EMAIL_RE = /^[A-Za-z0-9][A-Za-z0-9._%+'-]*@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
  const TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { return 'UTC'; } })();
  const fmtDate = ms => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  const fmtDateTime = ms => new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : (many || one + 's'));
  const reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  function listNames(people) {
    const names = people.map(p => p.name);
    if (!names.length) return 'nobody';
    if (names.length === 1) return names[0];
    if (names.length <= 3) return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
    return names.slice(0, 2).join(', ') + ' and ' + (names.length - 2) + ' others';
  }

  // localStorage with an in-memory fallback (private windows, blocked storage)
  const mem = {};
  const store = {
    get(k) {
      try { const v = localStorage.getItem(k); if (v != null) return JSON.parse(v); } catch (e) { /* fall through */ }
      return k in mem ? mem[k] : null;
    },
    set(k, v) { mem[k] = v; try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* memory only */ } },
    del(k) { delete mem[k]; try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
  };

  /* ================= email texts (used by the demo) ================= */
  function mailFor(kind, w, extra) {
    extra = extra || {};
    const n = w.recipients.length;
    const days = CONFIG.CHECK_IN_DAYS;
    if (kind === 'confirm') return {
      to: w.ownerEmail, action: 'Confirm my email',
      subject: 'Confirm your email to start your will timer',
      body: `Hi ${w.ownerName},\n\nYou wrote a will on Amanah for ${plural(n, 'person', 'people')}. Please confirm this is your email address. Your ${days}-day timer starts when you do.\n\nKeep this email. It also has your private link for checking, editing or deleting your will.\n\nDidn't sign up? Ignore this email. Nothing will be sent, and the draft is deleted after ${CONFIG.PENDING_EXPIRY_DAYS} days.`,
    };
    if (kind === 'link') return {
      to: w.ownerEmail, action: 'Open my will',
      subject: 'Your private link to manage your will',
      body: `Hi ${w.ownerName},\n\nHere is your private link. Use it to check your timer, tell us you're still here, or edit or delete your will.\n\nDon't forward this email. Anyone with the link can manage your will.`,
    };
    if (kind === 'reminder') {
      const last = extra.left <= DAY;
      const d = Math.max(1, Math.ceil(extra.left / DAY));
      return {
        to: w.ownerEmail, action: "I'm still here",
        subject: last ? 'Last reminder: your will is sent within 24 hours' : `${d} days left: are you still here?`,
        body: `Hi ${w.ownerName},\n\nIf we don't hear from you, your will goes to ${listNames(w.recipients)} on ${fmtDateTime(w.deadline)}.\n\nIf you're still here, click the button below and you get another ${days} days.\n\nYou last checked in on ${fmtDate(w.lastCheckIn)}.`,
      };
    }
    if (kind === 'delivery') {
      const p = extra.person;
      return {
        to: p.email,
        subject: `A message from ${w.ownerName}`,
        body: `Dear ${p.name},\n\n${w.ownerName} wrote the message below and asked Amanah to send it to you if they stopped responding. They last checked in on ${fmtDate(w.lastCheckIn)} and did not answer our reminders after that.\n\nWe're sorry if this reaches you at a difficult time.\n\n──────────\n${w.message}\n──────────` +
          (p.note ? `\n\nA note just for you:\n${p.note}` : '') +
          `\n\nThis message is not a legal will. If you believe ${w.ownerName} is safe, please contact them directly.`,
      };
    }
    if (kind === 'delivered') return {
      to: w.ownerEmail, action: 'Open my will',
      subject: 'Your will has been delivered',
      body: `Hi ${w.ownerName},\n\nWe didn't hear from you for ${days} days, so your will was sent to ${listNames(w.recipients)}.\n\nIf you're reading this, please contact them. They may be worried.`,
    };
    return { to: w.ownerEmail, subject: 'Amanah', body: '' };
  }

  /* ================= demo backend (runs in the browser) ================= */
  function createDemo() {
    const KEY = 'amanah-demo-v1';
    let s = store.get(KEY);
    if (!s || !s.wills || typeof s.offset !== 'number' || !Array.isArray(s.outbox)) s = seed();
    const now = () => Date.now() + s.offset * DAY;
    const save = () => store.set(KEY, s);
    const uid = p => p + Math.random().toString(36).slice(2, 10);

    function seed() {
      const t = Date.now();
      const confirmed = t - 28 * DAY;
      const w = {
        id: 'w_example', token: 't_example', example: true,
        ownerName: 'Ahmed Raza', ownerEmail: 'ahmed.raza@example.com', timeZone: TZ,
        message: 'To my family,\n\nIf you are reading this, I could not say these things in person.\n\n1. I owe Usman Tariq 40,000. Please repay him first. The receipt is in the blue diary in my desk drawer.\n2. My bank papers and the house file are in the steel cupboard, top shelf. Sara has the key.\n3. Divide what I leave as the law and our faith require. Ask Maulana Sahib at the masjid if you are unsure.\n4. Give my books to the school library in our village.\n\nForgive me for any hurt I caused. Look after each other.\n\nAhmed',
        recipients: [
          { name: 'Sara Raza', email: 'sara.raza@example.com', relation: 'Wife', note: 'The cupboard key is the small brass one on your ring. Thank you for nineteen years.', sentAt: 0 },
          { name: 'Hamza Raza', email: 'hamza.raza@example.com', relation: 'Son', note: 'Be gentle with your mother, and finish your degree.', sentAt: 0 },
          { name: 'Usman Tariq', email: 'usman.tariq@example.com', relation: 'Friend', note: 'Thank you for trusting me. My family will repay you before anything else is divided.', sentAt: 0 },
        ],
        status: 'active', createdAt: confirmed - 3600000, confirmedAt: confirmed, lastCheckIn: confirmed,
        deadline: confirmed + CONFIG.CHECK_IN_DAYS * DAY, remindersSent: [], deliveredAt: 0,
      };
      const state = { offset: 0, wills: {}, current: { id: w.id, token: w.token }, outbox: [] };
      state.wills[w.id] = w;
      state.outbox.push(Object.assign({ id: 'm_seed', at: w.createdAt, kind: 'confirm', willId: w.id }, mailFor('confirm', w)));
      return state;
    }

    function send(kind, w, extra) {
      s.outbox.unshift(Object.assign({ id: uid('m_'), at: now(), kind, willId: w.id }, mailFor(kind, w, extra)));
      if (s.outbox.length > 60) s.outbox.length = 60;
    }
    function pub(w) {
      const will = JSON.parse(JSON.stringify(w));
      delete will.token;
      will.checkInDays = CONFIG.CHECK_IN_DAYS;
      will.reminderDays = CONFIG.REMINDER_DAYS;
      return { ok: true, will };
    }
    function auth(p) {
      const w = p && s.wills[p.id];
      if (!w || w.token !== p.token || w.status === 'deleted') throw new Error('This link is not valid or has expired. Use “Email me my link” to get a new one.');
      return w;
    }
    function checkIn(w) {
      const t = now();
      w.lastCheckIn = t;
      w.deadline = t + CONFIG.CHECK_IN_DAYS * DAY;
      w.remindersSent = [];
    }
    const isOpen = w => w.status === 'pending' || w.status === 'active';

    const actions = {
      create(p) {
        const email = String(p.ownerEmail).toLowerCase();
        const open = Object.values(s.wills).find(w => !w.example && w.ownerEmail === email && isOpen(w));
        if (open) {
          send(open.status === 'pending' ? 'confirm' : 'link', open);
          s.current = { id: open.id, token: open.token };
          return { ok: true };
        }
        const w = {
          id: uid('w_'), token: uid('t_'),
          ownerName: p.ownerName, ownerEmail: email, timeZone: p.timeZone || TZ,
          message: p.message, recipients: p.recipients.map(r => Object.assign({}, r, { sentAt: 0 })),
          status: 'pending', createdAt: now(), confirmedAt: 0, lastCheckIn: 0, deadline: 0, remindersSent: [], deliveredAt: 0,
        };
        s.wills[w.id] = w;
        s.current = { id: w.id, token: w.token };
        send('confirm', w);
        return { ok: true };
      },
      confirm(p) {
        const w = auth(p);
        if (w.status === 'pending') { w.status = 'active'; w.confirmedAt = now(); checkIn(w); }
        return pub(w);
      },
      status(p) { return pub(auth(p)); },
      extend(p) {
        const w = auth(p);
        if (w.status !== 'active') throw new Error(w.status === 'pending' ? 'Confirm your email first. The link is in the email we sent you.' : 'This will can no longer be extended.');
        checkIn(w);
        return pub(w);
      },
      update(p) {
        const w = auth(p);
        if (!isOpen(w)) throw new Error('This will was already delivered. Write a new one instead.');
        w.ownerName = p.ownerName;
        w.message = p.message;
        w.recipients = p.recipients.map(r => Object.assign({}, r, { sentAt: 0 }));
        if (w.status === 'active') checkIn(w);
        return pub(w);
      },
      delete(p) {
        const w = auth(p);
        w.status = 'deleted'; w.message = ''; w.recipients = [];
        return { ok: true };
      },
      resend(p) {
        const email = String(p.email || '').toLowerCase();
        const w = Object.values(s.wills).find(x => x.ownerEmail === email && (isOpen(x) || x.status === 'delivered'));
        if (w) send(w.status === 'pending' ? 'confirm' : 'link', w);
        return { ok: true };
      },
    };

    // Same rules as hourlyCheck() in Code.gs
    function check() {
      const t = now();
      let count = 0;
      Object.values(s.wills).forEach(w => {
        if (w.status === 'pending' && t - w.createdAt > CONFIG.PENDING_EXPIRY_DAYS * DAY) { w.status = 'expired'; return; }
        if (w.status !== 'active') return;
        const left = w.deadline - t;
        if (left <= 0) {
          w.recipients.forEach(p => { if (!p.sentAt) { send('delivery', w, { person: p }); p.sentAt = t; count++; } });
          w.status = 'delivered'; w.deliveredAt = t;
          send('delivered', w); count++;
          return;
        }
        const due = CONFIG.REMINDER_DAYS.filter(d => left <= d * DAY && w.remindersSent.indexOf(d) === -1);
        if (due.length) { send('reminder', w, { left }); w.remindersSent = w.remindersSent.concat(due); count++; }
      });
      return count;
    }

    return {
      now,
      async call(action, p) {
        await sleep(action === 'status' ? 0 : 350);
        const fn = actions[action];
        if (!fn) throw new Error('Unknown request.');
        const out = fn(p || {});
        save();
        return JSON.parse(JSON.stringify(out));
      },
      tick(days) { let n = 0; for (let i = 0; i < days; i++) { s.offset += 1; n += check(); } save(); return n; },
      reset() { s = seed(); save(); },
      get offset() { return s.offset; },
      get outbox() { return s.outbox; },
      mail: id => s.outbox.find(m => m.id === id),
      will: id => s.wills[id],
      getCurrent: () => s.current,
      setCurrent: v => { s.current = v; save(); },
    };
  }

  /* ================= API (real or demo) ================= */
  const Demo = DEMO ? createDemo() : null;
  let clockSkew = 0;
  const api = {
    now: () => (DEMO ? Demo.now() : Date.now() + clockSkew),
    async call(action, payload) {
      if (DEMO) return Demo.call(action, payload);
      let res;
      try {
        // text/plain body keeps this a "simple" request, which Apps Script accepts without CORS preflight
        res = await fetch(CONFIG.API_URL, { method: 'POST', body: JSON.stringify(Object.assign({ action }, payload || {})) });
      } catch (e) {
        throw new Error("We couldn't reach the server. Check your internet connection and try again.");
      }
      let data;
      try { data = await res.json(); } catch (e) { throw new Error('The server sent an unexpected reply. Please try again in a minute.'); }
      if (!data || !data.ok) throw new Error((data && data.error) || 'Something went wrong. Please try again.');
      if (data.will && data.will.serverTime) clockSkew = data.will.serverTime - Date.now();
      return data;
    },
  };
  const session = DEMO
    ? { get: () => Demo.getCurrent(), set: v => Demo.setCurrent(v), clear: () => Demo.setCurrent(null) }
    : { get: () => store.get('amanah-session'), set: v => store.set('amanah-session', v), clear: () => store.del('amanah-session') };

  /* ================= UI helpers ================= */
  const toastEl = $('#toast');
  let toastTimer = 0;
  function toast(msg, bad) {
    toastEl.textContent = msg;
    toastEl.classList.toggle('bad', !!bad);
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, 4500);
  }
  function setBusy(btn, on) {
    if (!btn) return;
    if (on) { btn.dataset.label = btn.textContent; btn.textContent = 'Working…'; btn.disabled = true; btn.setAttribute('aria-busy', 'true'); }
    else { if (btn.dataset.label) btn.textContent = btn.dataset.label; btn.disabled = false; btn.removeAttribute('aria-busy'); }
  }
  function goTo(id) {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
  }

  /* ================= the 90-tick dial ================= */
  const SVGNS = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs, text) {
    const el = document.createElementNS(SVGNS, tag);
    Object.keys(attrs).forEach(k => el.setAttribute(k, attrs[k]));
    if (text != null) el.textContent = text;
    return el;
  }
  function drawDial(svg, o) {
    if (!svg) return;
    const total = o.total || CONFIG.CHECK_IN_DAYS;
    const reminders = o.reminders || CONFIG.REMINDER_DAYS;
    const status = o.status || 'active';
    const active = status === 'active';
    const left = active ? Math.max(0, Math.min(total, o.left)) : (status === 'pending' ? total : 0);
    const elapsed = total - left;
    const C = 120;
    const ang = i => (i / total) * Math.PI * 2 - Math.PI / 2;
    const pt = (r, a) => [(C + r * Math.cos(a)).toFixed(2), (C + r * Math.sin(a)).toFixed(2)];

    svg.textContent = '';
    svg.setAttribute('viewBox', '0 0 240 240');
    const lit = [];
    for (let i = 0; i < total; i++) {
      const rem = reminders.indexOf(total - i) !== -1; // ticks at day 75 and day 89
      const a = pt(rem ? 84 : 93, ang(i));
      const b = pt(rem ? 110 : 105, ang(i));
      const line = svgEl('line', { x1: a[0], y1: a[1], x2: b[0], y2: b[1], class: 'tick' + (rem ? ' rem' : '') });
      if (active && i >= elapsed) { line.style.setProperty('--i', String(i - elapsed)); lit.push(line); }
      svg.appendChild(line);
    }
    svg.appendChild(svgEl('circle', { cx: C, cy: 5.5, r: 4.5, class: 'seal' })); // delivery day
    if (active) {
      const n = pt(76, ang(elapsed));
      svg.appendChild(svgEl('circle', { cx: n[0], cy: n[1], r: 3.5, class: 'now' })); // today
    }

    let label, num, unit, word = false;
    if (active) { label = `DAY ${elapsed} OF ${total}`; num = String(left); unit = left === 1 ? 'DAY LEFT' : 'DAYS LEFT'; }
    else if (status === 'pending') { label = 'TIMER'; num = String(total); unit = 'NOT STARTED'; }
    else if (status === 'delivered') { label = 'DELIVERED'; num = 'Sent'; word = true; unit = o.deliveredAt ? fmtDate(o.deliveredAt).toUpperCase() : ''; }
    else { label = 'DRAFT'; num = 'Off'; word = true; unit = 'EXPIRED'; }
    svg.appendChild(svgEl('text', { x: C, y: 92, class: 'dial-label' }, label));
    svg.appendChild(svgEl('text', { x: C, y: word ? 138 : 142, class: 'dial-num' + (word ? ' word' : '') }, num));
    svg.appendChild(svgEl('text', { x: C, y: 164, class: 'dial-unit' }, unit));

    const light = () => lit.forEach(l => l.classList.add('on'));
    if (o.animate && !reduceMotion) {
      svg.classList.add('animate');
      requestAnimationFrame(() => requestAnimationFrame(light));
    } else light();
  }

  /* ================= navbar ================= */
  const navToggle = $('#navToggle');
  const nav = $('#siteNav');
  function setNav(open) {
    navToggle.setAttribute('aria-expanded', String(open));
    nav.classList.toggle('open', open);
  }
  navToggle.addEventListener('click', () => setNav(navToggle.getAttribute('aria-expanded') !== 'true'));
  nav.addEventListener('click', e => { if (e.target.closest('a')) setNav(false); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') setNav(false); });

  const navLinks = $$('.site-nav a[href^="#"]:not(.btn)');
  if ('IntersectionObserver' in window) {
    const byId = new Map(navLinks.map(a => [a.getAttribute('href').slice(1), a]));
    const io = new IntersectionObserver(entries => {
      entries.forEach(en => {
        const a = byId.get(en.target.id);
        if (a && en.isIntersecting) { navLinks.forEach(l => l.removeAttribute('aria-current')); a.setAttribute('aria-current', 'true'); }
      });
    }, { rootMargin: '-45% 0px -50% 0px' });
    byId.forEach((a, id) => { const sec = document.getElementById(id); if (sec) io.observe(sec); });
  }

  /* ================= will form ================= */
  const form = $('#willForm');
  const done = $('#formDone');
  const submitBtn = $('#submitBtn');
  const formError = $('#formError');
  const recWrap = $('#recipients');
  const recTpl = $('#recipientTpl');
  const addBtn = $('#addRecipient');
  const msgInput = $('#message');
  let recSeq = 0;
  let editMode = false;

  function addRecipient(data) {
    if (recWrap.children.length >= CONFIG.MAX_RECIPIENTS) return;
    data = data || {};
    const node = recTpl.content.firstElementChild.cloneNode(true);
    const n = recSeq++;
    $$('[data-f]', node).forEach(inp => {
      const f = inp.dataset.f;
      inp.id = `r${n}-${f}`;
      const lab = $(`label[data-for="${f}"]`, node);
      if (lab) lab.htmlFor = inp.id;
      inp.value = data[f] || '';
    });
    recWrap.appendChild(node);
    renumber();
    return node;
  }
  function renumber() {
    const cards = $$('.recipient', recWrap);
    cards.forEach((el, i) => {
      $('.rec-num', el).textContent = 'Person ' + (i + 1);
      $('[data-act="remove"]', el).hidden = cards.length === 1;
    });
    $('#recCount').textContent = `${cards.length} of ${CONFIG.MAX_RECIPIENTS}`;
    addBtn.disabled = cards.length >= CONFIG.MAX_RECIPIENTS;
  }
  addBtn.addEventListener('click', () => {
    const node = addRecipient();
    if (node) $('[data-f="name"]', node).focus();
  });
  recWrap.addEventListener('click', e => {
    const b = e.target.closest('[data-act="remove"]');
    if (!b) return;
    b.closest('.recipient').remove();
    renumber();
  });

  function updateCount() {
    $('#msgCount').textContent = `${msgInput.value.length.toLocaleString()} / ${CONFIG.MAX_MESSAGE.toLocaleString()}`;
  }
  msgInput.addEventListener('input', updateCount);
  form.addEventListener('input', e => { if (e.target.hasAttribute('aria-invalid')) e.target.removeAttribute('aria-invalid'); });
  form.addEventListener('change', e => { if (e.target.id === 'agree') e.target.removeAttribute('aria-invalid'); });

  function collect() {
    return {
      ownerName: $('#ownerName').value.trim(),
      ownerEmail: $('#ownerEmail').value.trim().toLowerCase(),
      message: msgInput.value.trim(),
      recipients: $$('.recipient', recWrap).map(el => ({
        name: $('[data-f="name"]', el).value.trim(),
        email: $('[data-f="email"]', el).value.trim().toLowerCase(),
        relation: $('[data-f="relation"]', el).value.trim(),
        note: $('[data-f="note"]', el).value.trim(),
      })),
    };
  }
  function validate(d) {
    if (!d.ownerName) return [$('#ownerName'), 'Enter your name.'];
    if (!EMAIL_RE.test(d.ownerEmail)) return [$('#ownerEmail'), 'Enter a valid email address for yourself. Reminders go there.'];
    if (!d.message) return [msgInput, 'Write your will in the message box.'];
    const cards = $$('.recipient', recWrap);
    const seen = {};
    for (let i = 0; i < d.recipients.length; i++) {
      const p = d.recipients[i];
      const emailInput = $('[data-f="email"]', cards[i]);
      if (!p.name) return [$('[data-f="name"]', cards[i]), `Add a name for person ${i + 1}.`];
      if (!EMAIL_RE.test(p.email)) return [emailInput, `Add a valid email address for ${p.name}.`];
      if (p.email === d.ownerEmail) return [emailInput, `${p.name} can't use your own email. Reminders go to you, and the will goes to them.`];
      if (seen[p.email]) return [emailInput, `${p.email} is listed twice.`];
      seen[p.email] = true;
    }
    if (!$('#agree').checked) return [$('#agree'), 'Tick the box to confirm you understand how delivery works.'];
    return null;
  }
  function clearErrors() {
    formError.hidden = true;
    $$('[aria-invalid]', form).forEach(el => el.removeAttribute('aria-invalid'));
  }
  function showError(el, msg) {
    formError.textContent = msg;
    formError.hidden = false;
    if (el) { el.setAttribute('aria-invalid', 'true'); el.focus(); }
    else formError.scrollIntoView({ block: 'center', behavior: reduceMotion ? 'auto' : 'smooth' });
  }

  function resetForm() {
    form.reset();
    recWrap.textContent = '';
    addRecipient();
    updateCount();
    clearErrors();
    form.hidden = false;
    done.hidden = true;
  }
  function startEdit(w) {
    editMode = true;
    resetForm();
    $('#ownerName').value = w.ownerName;
    $('#ownerEmail').value = w.ownerEmail;
    $('#ownerEmail').readOnly = true;
    msgInput.value = w.message;
    updateCount();
    recWrap.textContent = '';
    (w.recipients.length ? w.recipients : [{}]).forEach(p => addRecipient(p));
    $('#agree').checked = true;
    $('#writeTitle').textContent = 'Edit your will';
    $('#writeLead').textContent = w.status === 'active'
      ? `Saving counts as a check-in, so your timer goes back to ${CONFIG.CHECK_IN_DAYS} days.`
      : 'Your email address stays the same. Everything else can change.';
    submitBtn.textContent = 'Save changes';
    $('#cancelEdit').hidden = false;
    goTo('write');
  }
  function exitEdit() {
    editMode = false;
    $('#ownerEmail').readOnly = false;
    $('#writeTitle').textContent = 'Write your will';
    $('#writeLead').textContent = 'Take your time. You can change it later, and every change counts as a check-in.';
    submitBtn.textContent = 'Save my will';
    $('#cancelEdit').hidden = true;
  }
  $('#cancelEdit').addEventListener('click', () => { exitEdit(); resetForm(); goTo('manage'); });
  $('#startOver').addEventListener('click', () => { resetForm(); $('#ownerName').focus(); });

  form.addEventListener('submit', async e => {
    e.preventDefault();
    clearErrors();
    const data = collect();
    const problem = validate(data);
    if (problem) { showError(problem[0], problem[1]); return; }
    setBusy(submitBtn, true);
    try {
      if (editMode) {
        const sess = session.get();
        if (!sess) throw new Error('Open your private link on this device before editing.');
        const res = await api.call('update', Object.assign({}, sess, data));
        current = res.will;
        exitEdit();
        resetForm();
        renderWill(current);
        toast(current.status === 'active' ? `Saved. Your timer is back to ${CONFIG.CHECK_IN_DAYS} days.` : 'Saved.');
        goTo('manage');
      } else {
        await api.call('create', Object.assign({ timeZone: TZ }, data));
        $('#doneEmail').textContent = data.ownerEmail;
        form.hidden = true;
        done.hidden = false;
        done.focus();
        if (DEMO) await loadManage();
      }
    } catch (err) {
      showError(null, err.message);
    } finally {
      setBusy(submitBtn, false);
      if (DEMO) renderConsole();
    }
  });

  /* ================= My will (dashboard) ================= */
  const root = $('#manageRoot');
  let current = null;
  let extendPrompt = false;

  async function loadManage() {
    const sess = session.get();
    if (!sess) {
      current = null;
      renderSignedOut();
    } else {
      try {
        const data = await api.call('status', sess);
        current = data.will;
        renderWill(current);
      } catch (e) {
        current = null;
        renderSignedOut(e.message);
      }
    }
    if (DEMO) renderConsole();
  }

  function renderSignedOut(error) {
    root.innerHTML = `
      <div class="card manage-empty">
        ${error ? `<p class="notice notice-bad">${esc(error)}</p>` : ''}
        <div class="manage-empty-grid">
          <div>
            <h3>Open your will on this device</h3>
            <p>Your private link is in the confirmation email we sent you. Open it on this device and your timer, reminders and settings appear here.</p>
            <a class="btn btn-secondary" href="#write">Write a new will</a>
          </div>
          <form class="resend" id="resendForm" novalidate>
            <label for="resendEmail">Lost the email? We'll send your link again.</label>
            <div class="inline-row">
              <input type="email" id="resendEmail" autocomplete="email" placeholder="you@example.com">
              <button class="btn btn-primary" type="submit">Email me my link</button>
            </div>
            <p class="form-msg" id="resendMsg" role="status"></p>
          </form>
        </div>
      </div>`;
  }

  function scheduleRow(type, title, sub, at, state) {
    return `<li class="sch-${type}">
      <span class="sch-dot" aria-hidden="true"></span>
      <span class="sch-text"><strong>${esc(title)}</strong><span>${esc(sub)} · <time datetime="${new Date(at).toISOString()}">${esc(fmtDateTime(at))}</time></span></span>
      <span class="chip ${state[0] ? 'chip-' + state[0] : ''}">${esc(state[1])}</span>
    </li>`;
  }

  function renderWill(w) {
    const now = api.now();
    const total = w.checkInDays || CONFIG.CHECK_IN_DAYS;
    const reminders = (w.reminderDays || CONFIG.REMINDER_DAYS).slice().sort((a, b) => b - a);
    const n = w.recipients.length;
    const left = w.status === 'active' ? Math.max(0, Math.ceil((w.deadline - now) / DAY)) : 0;
    const chips = [];
    let lead = '';
    let body = '';
    let actions = '';
    let after = '';
    let dialLabel = '';

    if (w.status === 'active') {
      chips.push('<span class="chip chip-ok">Active</span>');
      lead = `If you don't check in, your will is sent on <strong>${esc(fmtDateTime(w.deadline))}</strong>.`;
      const rows = reminders.map((d, i) => {
        const at = w.deadline - d * DAY;
        const sent = w.remindersSent.indexOf(d) !== -1;
        const title = reminders.length === 1 ? 'Reminder' : i === 0 ? 'First reminder' : i === reminders.length - 1 ? 'Last reminder' : 'Reminder';
        return scheduleRow('rem', title, `${plural(d, 'day')} before`, at, sent ? ['ok', 'Sent'] : at <= now ? ['warn', 'Sending'] : ['', 'Upcoming']);
      });
      rows.push(scheduleRow('deliver', `Delivery to ${plural(n, 'person', 'people')}`, listNames(w.recipients), w.deadline, ['brass', 'If no reply']));
      body = `<ol class="schedule">${rows.join('')}</ol>`;
      actions = `
        <button class="btn btn-primary" data-act="extend">I'm still here</button>
        <button class="btn btn-secondary" data-act="edit">Edit will</button>
        <button class="btn btn-ghost btn-danger-text" data-act="ask-delete">Delete</button>`;
      after = `<p class="small muted">“I'm still here” resets the timer to ${total} days from now.</p>`;
      dialLabel = `${left} of ${total} days left before delivery`;
    } else if (w.status === 'pending') {
      chips.push('<span class="chip chip-warn">Waiting for confirmation</span>');
      lead = `Open the email we sent to <strong>${esc(w.ownerEmail)}</strong> and click <strong>Confirm my email</strong>. Your ${total}-day timer starts then.`;
      actions = `
        <button class="btn btn-primary" data-act="resend-confirm">Send the email again</button>
        <button class="btn btn-secondary" data-act="edit">Edit will</button>
        <button class="btn btn-ghost btn-danger-text" data-act="ask-delete">Delete</button>`;
      dialLabel = 'Timer not started';
    } else if (w.status === 'delivered') {
      chips.push('<span class="chip chip-brass">Delivered</span>');
      lead = `Your will was sent to ${esc(listNames(w.recipients))} on <strong>${esc(fmtDateTime(w.deliveredAt))}</strong>.`;
      actions = `
        <button class="btn btn-primary" data-act="new">Write a new will</button>
        <button class="btn btn-ghost btn-danger-text" data-act="ask-delete">Delete stored copy</button>`;
      dialLabel = 'Delivered';
    } else {
      chips.push('<span class="chip chip-bad">Expired</span>');
      lead = `This draft was removed because the email address wasn't confirmed within ${CONFIG.PENDING_EXPIRY_DAYS} days.`;
      actions = `<button class="btn btn-primary" data-act="new">Write a new will</button>`;
      dialLabel = 'Expired draft';
    }
    if (w.example) chips.push('<span class="chip">Example</span>');

    const prompt = extendPrompt && w.status === 'active'
      ? `<p class="notice notice-brass"><strong>Still here?</strong> Press <strong>I'm still here</strong> below and your timer goes back to ${total} days.</p>`
      : '';
    const people = n ? `
      <details class="people">
        <summary>Who receives it (${n})</summary>
        <ul>${w.recipients.map(p => `<li><span><strong>${esc(p.name)}</strong>${p.relation ? ` <span class="muted">· ${esc(p.relation)}</span>` : ''}</span><span class="mono">${esc(p.email)}</span></li>`).join('')}</ul>
      </details>` : '';
    const delConfirm = `
      <div class="del-confirm" id="delConfirm" hidden>
        <p><strong>Delete this will for good?</strong> The text and the list of people are wiped, and nothing will be sent.</p>
        <div class="dash-actions">
          <button class="btn btn-danger" data-act="delete">Yes, delete it</button>
          <button class="btn btn-ghost" data-act="cancel-delete">Keep it</button>
        </div>
      </div>`;
    const meta = `<p class="dash-meta">${w.lastCheckIn ? `Last check-in ${esc(fmtDateTime(w.lastCheckIn))}. ` : ''}Times are in your time zone (${esc(TZ)}). <button type="button" class="link-btn" data-act="forget">Remove my link from this device</button></p>`;

    root.innerHTML = `
      <article class="card dash">
        <div class="dash-dial"><svg class="dial" id="dashDial" role="img" aria-label="${esc(dialLabel)}"></svg></div>
        <div class="dash-body">
          ${prompt}
          <div class="dash-top"><h3>${esc(w.ownerName)}'s will</h3>${chips.join('')}</div>
          <p class="dash-lead">${lead}</p>
          ${body}
          <div class="dash-actions">${actions}</div>
          ${after}
          ${delConfirm}
          ${people}
          ${meta}
        </div>
      </article>`;
    drawDial($('#dashDial'), { total, left, status: w.status, reminders, deliveredAt: w.deliveredAt });
  }

  root.addEventListener('click', async e => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'edit') { if (current) startEdit(current); return; }
    if (act === 'ask-delete') { const box = $('#delConfirm'); box.hidden = false; $('button', box).focus(); return; }
    if (act === 'cancel-delete') { $('#delConfirm').hidden = true; return; }
    if (act === 'forget') { session.clear(); current = null; extendPrompt = false; renderSignedOut(); if (DEMO) renderConsole(); toast('Your link was removed from this device.'); return; }
    if (act === 'new') { session.clear(); current = null; extendPrompt = false; exitEdit(); resetForm(); renderSignedOut(); if (DEMO) renderConsole(); goTo('write'); return; }

    setBusy(b, true);
    try {
      if (act === 'extend') {
        const res = await api.call('extend', session.get());
        extendPrompt = false;
        current = res.will;
        renderWill(current);
        toast(`Thank you. You have ${CONFIG.CHECK_IN_DAYS} days again.`);
      } else if (act === 'delete') {
        await api.call('delete', session.get());
        session.clear();
        current = null;
        if (editMode) { exitEdit(); resetForm(); }
        renderSignedOut();
        toast('Your will was deleted.');
      } else if (act === 'resend-confirm') {
        await api.call('resend', { email: current.ownerEmail });
        toast('We sent the confirmation email again.');
      }
    } catch (err) {
      toast(err.message, true);
    } finally {
      setBusy(b, false);
      if (DEMO) renderConsole();
    }
  });

  root.addEventListener('submit', async e => {
    if (e.target.id !== 'resendForm') return;
    e.preventDefault();
    const input = $('#resendEmail');
    const msg = $('#resendMsg');
    const btn = $('button', e.target);
    const email = input.value.trim().toLowerCase();
    if (!EMAIL_RE.test(email)) {
      input.setAttribute('aria-invalid', 'true');
      msg.className = 'form-msg bad';
      msg.textContent = 'Enter the email address you used for your will.';
      input.focus();
      return;
    }
    input.removeAttribute('aria-invalid');
    setBusy(btn, true);
    try {
      await api.call('resend', { email });
      msg.className = 'form-msg ok';
      msg.textContent = `If a will is saved under ${email}, the link is on its way. Check your spam folder too.`;
    } catch (err) {
      msg.className = 'form-msg bad';
      msg.textContent = err.message;
    } finally {
      setBusy(btn, false);
      if (DEMO) renderConsole();
    }
  });

  /* ================= demo console ================= */
  const KIND = {
    confirm: ['Confirmation', ''],
    link: ['Your link', ''],
    reminder: ['Reminder', 'brass'],
    delivery: ['Delivered will', 'ok'],
    delivered: ['Notice to owner', ''],
  };
  function mailItem(m) {
    const k = KIND[m.kind] || ['Email', ''];
    const action = m.action ? `<button type="button" class="btn btn-primary btn-sm" data-ob="${esc(m.id)}">Click “${esc(m.action)}”</button>` : '';
    return `<li><details>
      <summary>
        <span class="chip ${k[1] ? 'chip-' + k[1] : ''}">${esc(k[0])}</span>
        <span class="ob-subj">${esc(m.subject)}</span>
        <span class="ob-meta">To ${esc(m.to)} · ${esc(fmtDate(m.at))}</span>
      </summary>
      <div class="ob-body" dir="auto">${esc(m.body)}</div>
      ${action}
    </details></li>`;
  }
  function renderConsole() {
    const el = $('#demoConsole');
    const mails = Demo.outbox.slice(0, 30);
    el.hidden = false;
    el.innerHTML = `
      <div class="console-head">
        <div>
          <h3>Demo console</h3>
          <p>Nothing here is really sent. Skip ahead in time to watch the reminders and the delivery happen.</p>
        </div>
        <div class="time-machine">
          <span class="tm-date">Demo date <strong>${esc(fmtDate(Demo.now()))}</strong>${Demo.offset ? `<span class="chip">+${plural(Demo.offset, 'day')}</span>` : ''}</span>
          <div class="tm-btns">
            <button type="button" class="btn btn-secondary btn-sm" data-tm="1">+1 day</button>
            <button type="button" class="btn btn-secondary btn-sm" data-tm="7">+7 days</button>
            <button type="button" class="btn btn-secondary btn-sm" data-tm="30">+30 days</button>
            <button type="button" class="btn btn-ghost btn-sm" data-tm="reset">Reset demo</button>
          </div>
        </div>
      </div>
      <h4 class="outbox-title">Outbox <span class="count">${Demo.outbox.length}</span></h4>
      <ul class="outbox">${mails.map(mailItem).join('') || '<li class="empty">No emails yet.</li>'}</ul>`;
  }
  if (DEMO) {
    $('#demoConsole').addEventListener('click', async e => {
      const tm = e.target.closest('[data-tm]');
      if (tm) {
        if (tm.dataset.tm === 'reset') {
          Demo.reset();
          extendPrompt = false;
          if (editMode) exitEdit();
          resetForm();
          toast('Demo reset to the example will.');
        } else {
          const days = Number(tm.dataset.tm);
          const n = Demo.tick(days);
          toast(n ? `${plural(n, 'new email')} in the outbox.` : `Skipped ${plural(days, 'day')}. No new emails.`);
        }
        await loadManage();
        return;
      }
      const ob = e.target.closest('[data-ob]');
      if (!ob) return;
      const m = Demo.mail(ob.dataset.ob);
      const w = m && Demo.will(m.willId);
      if (!w) return;
      session.set({ id: w.id, token: w.token });
      if (m.kind === 'confirm' && w.status === 'pending') {
        try { await api.call('confirm', session.get()); toast(`Email confirmed. Your ${CONFIG.CHECK_IN_DAYS}-day timer has started.`); }
        catch (err) { toast(err.message, true); }
      }
      extendPrompt = m.kind === 'reminder';
      await loadManage();
      goTo('manage');
    });
  }

  /* ================= dialogs ================= */
  $$('[data-dialog]').forEach(btn => btn.addEventListener('click', () => {
    const d = document.getElementById(btn.dataset.dialog);
    if (!d) return;
    if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '');
  }));
  $$('dialog').forEach(d => {
    $$('[data-close]', d).forEach(b => b.addEventListener('click', () => (d.close ? d.close() : d.removeAttribute('open'))));
    d.addEventListener('click', e => { if (e.target === d && d.close) d.close(); }); // click outside closes
  });

  /* ================= links from emails (live mode) ================= */
  function readEmailLink() {
    if (DEMO) return null;
    const q = new URLSearchParams(location.search);
    const id = q.get('id');
    const t = q.get('t');
    if (!id || !t) return null;
    session.set({ id, token: t });
    try { history.replaceState(null, '', location.pathname + '#manage'); } catch (e) { /* ignore */ }
    return q.get('action') || 'open';
  }

  /* ================= start ================= */
  async function init() {
    $('#year').textContent = String(new Date().getFullYear());
    $$('.tz-name').forEach(el => { el.textContent = TZ; });
    if (DEMO) {
      $('#demoBar').hidden = false;
      $$('.demo-only').forEach(el => { el.hidden = false; });
    }
    drawDial($('#heroDial'), { total: 90, left: 62, status: 'active', animate: true });
    addRecipient();
    updateCount();

    const fromEmail = readEmailLink();
    if (fromEmail === 'confirm') {
      try {
        const res = await api.call('confirm', session.get());
        current = res.will;
        renderWill(current);
        toast(`Email confirmed. Your ${CONFIG.CHECK_IN_DAYS}-day timer has started.`);
      } catch (e) {
        renderSignedOut(e.message);
      }
    } else {
      extendPrompt = fromEmail === 'extend';
      await loadManage();
    }
    if (fromEmail) goTo('manage');
  }

  init();
})();