/**
 * Amanah · backend (Google Apps Script)
 * ------------------------------------------------------------------
 * - Saves wills in this Google Sheet (tab "Wills")
 * - Emails the owner a confirmation link, then reminders
 *   15 days and 1 day before the deadline
 * - Emails the will to every recipient if the owner doesn't
 *   check in for 90 days
 *
 * Setup steps are in SETUP.md.
 * ------------------------------------------------------------------ */

const CONFIG = {
  SITE_NAME: 'Amanah',
  SITE_URL: 'https://your-site.netlify.app/', // ← your website address, ending with /
  CHECK_IN_DAYS: 90,
  REMINDER_DAYS: [15, 1],
  PENDING_EXPIRY_DAYS: 7,
  MAX_RECIPIENTS: 10,
  MAX_MESSAGE: 15000,
  MAX_NOTE: 1500,
  RESERVED_QUOTA: 25, // emails held back each day so reminders and deliveries never run out
  SHEET_NAME: 'Wills',
};

/* Testing only (SETUP.md, step 7) */
const TEST_EMAIL = 'you@example.com';
const TEST_SKIP_DAYS = 76;

const DAY_MS = 24 * 60 * 60 * 1000;
const COLS = ['id', 'token', 'ownerEmail', 'status', 'timeZone', 'createdAt', 'confirmedAt',
  'deadline', 'lastCheckIn', 'deliveredAt', 'remindersSent', 'data'];
const EMAIL_RE = /^[A-Za-z0-9][A-Za-z0-9._%+'-]*@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;

class UserError extends Error {}

/* ================= Run once from the editor ================= */
function setup() {
  const sheet = sheet_();
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'hourlyCheck') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('hourlyCheck').timeBased().everyHours(1).create();
  Logger.log('Setup done. Database tab: "' + sheet.getName() + '". Emails left today: ' + MailApp.getRemainingDailyQuota());
}

/* ================= Web app ================= */
function doGet() {
  return json_({ ok: true, service: CONFIG.SITE_NAME });
}

function doPost(e) {
  let out;
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const handler = ACTIONS[body.action];
    if (!handler) throw new UserError('Unknown request.');
    out = handler(body);
  } catch (err) {
    if (err instanceof UserError) {
      out = { ok: false, error: err.message };
    } else {
      console.error(err && err.stack ? err.stack : err);
      out = { ok: false, error: 'Something went wrong on our side. Please try again in a minute.' };
    }
  }
  return json_(out);
}

const ACTIONS = {
  create: b => locked_(createWill_, b),
  confirm: b => locked_(confirmWill_, b),
  status: b => publicWill_(auth_(b)),
  extend: b => locked_(extendWill_, b),
  update: b => locked_(updateWill_, b),
  delete: b => locked_(deleteWill_, b),
  resend: b => locked_(resendLink_, b),
};

/* ================= Actions ================= */
function createWill_(b) {
  const data = clean_(b, null);
  const open = rows_().find(r => r.ownerEmail === data.ownerEmail && (r.status === 'pending' || r.status === 'active'));
  if (open) {
    // One open will per email: send the existing link instead of creating a second will.
    if (!throttled_(open.ownerEmail)) {
      checkQuota_(1);
      if (open.status === 'pending') sendConfirm_(open); else sendLink_(open);
    }
    return { ok: true };
  }
  checkQuota_(1);
  const r = {
    id: 'w_' + Utilities.getUuid().replace(/-/g, ''),
    token: 't_' + Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, ''),
    ownerEmail: data.ownerEmail,
    ownerName: data.ownerName,
    message: data.message,
    recipients: data.recipients,
    status: 'pending',
    timeZone: cleanTz_(b.timeZone),
    createdAt: Date.now(),
    remindersSent: [],
  };
  save_(r);
  sendConfirm_(r);
  throttled_(r.ownerEmail);
  return { ok: true };
}

function confirmWill_(b) {
  const r = auth_(b);
  if (r.status === 'pending') {
    r.status = 'active';
    r.confirmedAt = Date.now();
    checkIn_(r);
    save_(r);
  }
  return publicWill_(r);
}

function extendWill_(b) {
  const r = auth_(b);
  if (r.status !== 'active') {
    throw new UserError(r.status === 'pending'
      ? 'Confirm your email first. The link is in the email we sent you.'
      : 'This will has already been delivered.');
  }
  checkIn_(r);
  save_(r);
  return publicWill_(r);
}

function updateWill_(b) {
  const r = auth_(b);
  if (r.status !== 'active' && r.status !== 'pending') throw new UserError('This will was already delivered. Write a new one instead.');
  const data = clean_(b, r.ownerEmail); // the owner email can't change
  r.ownerName = data.ownerName;
  r.message = data.message;
  r.recipients = data.recipients;
  if (r.status === 'active') checkIn_(r); // editing counts as a check-in
  save_(r);
  return publicWill_(r);
}

function deleteWill_(b) {
  const r = auth_(b);
  wipe_(r, 'deleted');
  save_(r);
  return { ok: true };
}

function resendLink_(b) {
  const email = email_(b.email, 'yourself');
  const matches = rows_()
    .filter(r => r.ownerEmail === email && ['pending', 'active', 'delivered'].indexOf(r.status) !== -1)
    .sort((a, c) => c.createdAt - a.createdAt);
  const r = matches[0];
  if (r && !throttled_(email)) {
    checkQuota_(1);
    if (r.status === 'pending') sendConfirm_(r); else sendLink_(r);
  }
  return { ok: true }; // same answer either way, so nobody can test which emails have a will
}

/* ================= Hourly check (time trigger) ================= */
function hourlyCheck() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(60000)) return;
  try {
    const now = Date.now();
    rows_().forEach(r => {
      try { processRow_(r, now); }
      catch (err) { console.error('Row ' + r._row + ': ' + (err && err.stack ? err.stack : err)); }
    });
  } finally {
    lock.releaseLock();
  }
}

function processRow_(r, now) {
  if (r.status === 'pending' && now - r.createdAt > CONFIG.PENDING_EXPIRY_DAYS * DAY_MS) {
    wipe_(r, 'expired');
    save_(r);
    return;
  }
  if (r.status !== 'active') return;

  const left = r.deadline - now;
  if (left <= 0) {
    deliver_(r, now);
    return;
  }
  const due = CONFIG.REMINDER_DAYS.filter(d => left <= d * DAY_MS && r.remindersSent.indexOf(d) === -1);
  if (!due.length || MailApp.getRemainingDailyQuota() < 1) return;
  sendReminder_(r, left);
  r.remindersSent = r.remindersSent.concat(due);
  save_(r);
}

function deliver_(r, now) {
  const waiting = r.recipients.filter(p => !p.sentAt);
  if (MailApp.getRemainingDailyQuota() < waiting.length + 1) return; // not enough emails left today, try next hour
  waiting.forEach(p => {
    sendDelivery_(r, p);
    p.sentAt = Date.now();
    save_(r); // saved per person, so nobody gets a second copy if something fails halfway
  });
  r.status = 'delivered';
  r.deliveredAt = now;
  save_(r);
  try { sendDelivered_(r); } catch (err) { console.error(err); }
}

/* ================= Emails ================= */
function sendConfirm_(r) {
  const manage = link_(r);
  mail_({
    to: r.ownerEmail,
    subject: 'Confirm your email to start your will timer',
    heading: 'Confirm your email',
    parts: [
      { text: 'Hi ' + r.ownerName + ',' },
      { text: 'You wrote a will on ' + CONFIG.SITE_NAME + ' for ' + people_(r.recipients.length) + '. Please confirm this is your email address. Your ' + CONFIG.CHECK_IN_DAYS + '-day timer starts when you do.' },
    ],
    button: { label: 'Confirm my email', url: link_(r, 'confirm') },
    after: [{
      html: '<p style="margin:0 0 14px">Keep this email. This private link lets you check your timer, edit or delete your will at any time:<br><a href="' + manage + '" style="color:#1E4A40;word-break:break-all">' + esc_(manage) + '</a></p>',
      plain: 'Keep this email. Your private link to manage your will:\n' + manage,
    }],
    foot: "Didn't sign up? Ignore this email. Nothing will be sent, and the draft is deleted after " + CONFIG.PENDING_EXPIRY_DAYS + ' days.',
  });
}

function sendLink_(r) {
  mail_({
    to: r.ownerEmail,
    subject: 'Your private link to manage your will',
    heading: 'Your private link',
    parts: [
      { text: 'Hi ' + r.ownerName + ',' },
      { text: "Here is your private link. Use it to check your timer, tell us you're still here, or edit or delete your will." },
    ],
    button: { label: 'Open my will', url: link_(r) },
    foot: "Don't forward this email. Anyone with the link can manage your will.",
  });
}

function sendReminder_(r, leftMs) {
  const last = leftMs <= DAY_MS;
  const days = Math.max(1, Math.ceil(leftMs / DAY_MS));
  mail_({
    to: r.ownerEmail,
    subject: last ? 'Last reminder: your will is sent within 24 hours' : days + ' days left: are you still here?',
    heading: last ? 'Your will is sent within 24 hours' : 'Are you still here?',
    parts: [
      { text: 'Hi ' + r.ownerName + ',' },
      { text: "If we don't hear from you, your will goes to " + names_(r.recipients) + ' on ' + fmt_(r.deadline, r.timeZone) + '.' },
      { text: "If you're still here, click the button below and you get another " + CONFIG.CHECK_IN_DAYS + ' days.' },
    ],
    button: { label: "I'm still here", url: link_(r, 'extend') },
    foot: 'You last checked in on ' + fmt_(r.lastCheckIn, r.timeZone) + '. Add this address to your contacts so our reminders never land in spam.',
  });
}

function sendDelivery_(r, p) {
  const parts = [
    { text: 'Dear ' + p.name + ',' },
    { text: r.ownerName + ' wrote the message below and asked ' + CONFIG.SITE_NAME + ' to send it to you if they stopped responding. They last checked in on ' + fmt_(r.lastCheckIn, r.timeZone) + ' and did not answer our reminders after that.' },
    { text: "We're sorry if this reaches you at a difficult time." },
    quote_(r.message),
  ];
  if (p.note) {
    parts.push({ html: '<p style="margin:8px 0 8px;font-weight:bold">A note just for you</p>', plain: 'A note just for you:' });
    parts.push(quote_(p.note));
  }
  mail_({
    to: p.email,
    subject: 'A message from ' + r.ownerName,
    heading: 'A message from ' + r.ownerName,
    parts: parts,
    foot: 'This message is not a legal will. If you believe ' + r.ownerName + ' is safe, please contact them directly.',
  });
}

function sendDelivered_(r) {
  mail_({
    to: r.ownerEmail,
    subject: 'Your will has been delivered',
    heading: 'Your will has been delivered',
    parts: [
      { text: 'Hi ' + r.ownerName + ',' },
      { text: "We didn't hear from you for " + CONFIG.CHECK_IN_DAYS + ' days, so your will was sent to ' + names_(r.recipients) + ' on ' + fmt_(r.deliveredAt, r.timeZone) + '.' },
      { text: "If you're reading this, please contact them. They may be worried." },
    ],
    button: { label: 'Open my will', url: link_(r) },
  });
}

/* ================= Email layout ================= */
function mail_(m) {
  const html = (m.parts || []).map(partHtml_).join('');
  const after = (m.after || []).map(partHtml_).join('');
  const plain = []
    .concat((m.parts || []).map(partPlain_))
    .concat(m.button ? [m.button.label + ': ' + m.button.url] : [])
    .concat((m.after || []).map(partPlain_))
    .concat(m.foot ? ['--', m.foot] : [])
    .join('\n\n');
  MailApp.sendEmail({
    to: m.to,
    subject: m.subject,
    name: CONFIG.SITE_NAME,
    body: plain,
    htmlBody: layout_(m.heading || m.subject, html, m.button, after, m.foot),
  });
}

function layout_(heading, bodyHtml, button, afterHtml, foot) {
  const btn = button
    ? '<p style="margin:26px 0"><a href="' + button.url + '" style="background:#1E4A40;color:#ffffff;text-decoration:none;padding:13px 24px;border-radius:8px;font-weight:bold;display:inline-block">' + esc_(button.label) + '</a></p>'
    : '';
  const footHtml = foot
    ? '<p style="font-size:12px;line-height:1.55;color:#55635E;border-top:1px solid #D2DBD7;padding-top:16px;margin:26px 0 0">' + esc_(foot) + '</p>'
    : '';
  return '<div style="background:#F1F4F2;padding:32px 14px;font-family:Arial,Helvetica,sans-serif;color:#15211E">' +
    '<div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #D2DBD7;border-radius:12px;padding:30px">' +
    '<p style="margin:0 0 22px;font-family:Georgia,serif;font-size:20px;color:#1E4A40">' + esc_(CONFIG.SITE_NAME) + '</p>' +
    '<h1 style="font-family:Georgia,serif;font-weight:normal;font-size:26px;line-height:1.25;margin:0 0 18px">' + esc_(heading) + '</h1>' +
    '<div style="font-size:15px;line-height:1.65">' + bodyHtml + '</div>' + btn +
    '<div style="font-size:15px;line-height:1.65">' + (afterHtml || '') + '</div>' + footHtml +
    '</div></div>';
}

function partHtml_(x) { return x.html != null ? x.html : '<p style="margin:0 0 14px" dir="auto">' + nl_(x.text) + '</p>'; }
function partPlain_(x) { return x.plain != null ? x.plain : x.text; }
function quote_(text) {
  return {
    html: '<div dir="auto" style="border-left:3px solid #8E6219;background:#F6F8F7;padding:14px 18px;margin:4px 0 18px;font-size:15px;line-height:1.7">' + nl_(text) + '</div>',
    plain: '----------\n' + text + '\n----------',
  };
}

/* ================= Sheet storage ================= */
function sheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(CONFIG.SHEET_NAME);
    sh.appendRow(COLS);
    sh.setFrozenRows(1);
  }
  return sh;
}

function rows_() {
  const values = sheet_().getDataRange().getValues();
  const out = [];
  for (let i = 1; i < values.length; i++) {
    const o = {};
    COLS.forEach((c, j) => { o[c] = values[i][j]; });
    if (!o.id) continue;
    const data = parse_(o.data, {});
    out.push({
      _row: i + 1,
      id: String(o.id),
      token: String(o.token || ''),
      ownerEmail: String(o.ownerEmail || ''),
      status: String(o.status || ''),
      timeZone: String(o.timeZone || 'UTC'),
      createdAt: Number(o.createdAt) || 0,
      confirmedAt: Number(o.confirmedAt) || 0,
      deadline: Number(o.deadline) || 0,
      lastCheckIn: Number(o.lastCheckIn) || 0,
      deliveredAt: Number(o.deliveredAt) || 0,
      remindersSent: parse_(o.remindersSent, []),
      ownerName: String(data.ownerName || ''),
      message: String(data.message || ''),
      recipients: Array.isArray(data.recipients) ? data.recipients : [],
    });
  }
  return out;
}

// User text is stored as JSON (starts with { or [), so Sheets never reads it as a formula, date or number.
function save_(r) {
  const flat = {
    id: r.id,
    token: r.token || '',
    ownerEmail: r.ownerEmail,
    status: r.status,
    timeZone: r.timeZone || 'UTC',
    createdAt: r.createdAt || '',
    confirmedAt: r.confirmedAt || '',
    deadline: r.deadline || '',
    lastCheckIn: r.lastCheckIn || '',
    deliveredAt: r.deliveredAt || '',
    remindersSent: JSON.stringify(r.remindersSent || []),
    data: JSON.stringify({ ownerName: r.ownerName || '', message: r.message || '', recipients: r.recipients || [] }),
  };
  if (flat.data.length > 49000) throw new UserError('Your will is too long to save. Please shorten the message or the notes.');
  const line = COLS.map(c => flat[c]);
  const sh = sheet_();
  if (r._row) {
    sh.getRange(r._row, 1, 1, COLS.length).setValues([line]);
  } else {
    sh.appendRow(line);
    r._row = sh.getLastRow();
  }
}

/* ================= Helpers ================= */
function auth_(b) {
  const id = String((b && b.id) || '');
  const token = String((b && b.token) || '');
  const r = id && token ? rows_().find(x => x.id === id) : null;
  if (!r || !r.token || r.token !== token) {
    throw new UserError('This link is not valid or has expired. Use "Email me my link" on the website to get a new one.');
  }
  return r;
}

function publicWill_(r) {
  return {
    ok: true,
    will: {
      ownerName: r.ownerName,
      ownerEmail: r.ownerEmail,
      message: r.message,
      recipients: r.recipients.map(p => ({ name: p.name, email: p.email, relation: p.relation || '', note: p.note || '', sentAt: p.sentAt || 0 })),
      status: r.status,
      createdAt: r.createdAt,
      confirmedAt: r.confirmedAt,
      deadline: r.deadline,
      lastCheckIn: r.lastCheckIn,
      deliveredAt: r.deliveredAt,
      remindersSent: r.remindersSent,
      checkInDays: CONFIG.CHECK_IN_DAYS,
      reminderDays: CONFIG.REMINDER_DAYS,
      serverTime: Date.now(),
    },
  };
}

function clean_(b, fixedEmail) {
  const ownerName = text_(b.ownerName, 80);
  const ownerEmail = fixedEmail || email_(b.ownerEmail, 'yourself');
  const message = text_(b.message, CONFIG.MAX_MESSAGE);
  if (!ownerName) throw new UserError('Please enter your name.');
  if (!message) throw new UserError('Please write your will before saving.');
  const list = Array.isArray(b.recipients) ? b.recipients : [];
  if (!list.length) throw new UserError('Add at least one person to receive your will.');
  if (list.length > CONFIG.MAX_RECIPIENTS) throw new UserError('You can add up to ' + CONFIG.MAX_RECIPIENTS + ' people.');
  const seen = {};
  const recipients = list.map((p, i) => {
    p = p || {};
    const name = text_(p.name, 80);
    if (!name) throw new UserError('Person ' + (i + 1) + ' needs a name.');
    const email = email_(p.email, name);
    if (email === ownerEmail) throw new UserError(name + " can't use your own email address.");
    if (seen[email]) throw new UserError(email + ' is listed twice.');
    seen[email] = true;
    return { name: name, email: email, relation: text_(p.relation, 60), note: text_(p.note, CONFIG.MAX_NOTE), sentAt: 0 };
  });
  return { ownerName: ownerName, ownerEmail: ownerEmail, message: message, recipients: recipients };
}

function checkIn_(r) {
  const now = Date.now();
  r.lastCheckIn = now;
  r.deadline = now + CONFIG.CHECK_IN_DAYS * DAY_MS;
  r.remindersSent = [];
}

function wipe_(r, status) {
  r.status = status;
  r.token = '';
  r.ownerName = '';
  r.message = '';
  r.recipients = [];
}

function link_(r, action) {
  let url = CONFIG.SITE_URL + '?id=' + encodeURIComponent(r.id) + '&t=' + encodeURIComponent(r.token);
  if (action) url += '&action=' + action;
  return url + '#manage';
}

function checkQuota_(n) {
  if (MailApp.getRemainingDailyQuota() - n < CONFIG.RESERVED_QUOTA) {
    throw new UserError("We've reached today's email limit. Please try again tomorrow.");
  }
}

// At most one "link" email per address every 10 minutes
function throttled_(email) {
  const cache = CacheService.getScriptCache();
  const key = 'mail_' + Utilities.base64EncodeWebSafe(email);
  if (cache.get(key)) return true;
  cache.put(key, '1', 600);
  return false;
}

function text_(v, max) { return String(v == null ? '' : v).replace(/\r\n?/g, '\n').trim().slice(0, max); }

function email_(v, whose) {
  const e = String(v || '').trim().toLowerCase();
  if (e.length > 120 || !EMAIL_RE.test(e)) throw new UserError('Please enter a valid email address for ' + whose + '.');
  return e;
}

function cleanTz_(tz) {
  tz = String(tz || '');
  if (!/^[A-Za-z0-9_+\-\/]{1,64}$/.test(tz)) return 'UTC';
  try { Utilities.formatDate(new Date(), tz, 'yyyy'); return tz; } catch (e) { return 'UTC'; }
}

function fmt_(ms, tz) {
  if (!ms) return 'an unknown date';
  return Utilities.formatDate(new Date(ms), tz || 'UTC', 'd MMM yyyy, h:mm a') + ' (' + (tz || 'UTC') + ')';
}

function people_(n) { return n === 1 ? '1 person' : n + ' people'; }

function names_(list) {
  const names = list.map(p => p.name);
  if (names.length <= 1) return names[0] || 'the people you chose';
  if (names.length <= 3) return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
  return names.slice(0, 2).join(', ') + ' and ' + (names.length - 2) + ' others';
}

function parse_(v, fallback) { try { return v ? JSON.parse(String(v)) : fallback; } catch (e) { return fallback; } }
function esc_(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
function nl_(s) { return esc_(s).replace(/\n/g, '<br>'); }
function json_(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }

function locked_(fn, body) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw new UserError('The server is busy. Please try again in a moment.');
  try { return fn(body); } finally { lock.releaseLock(); }
}

/* ================= Testing: skip time without waiting 90 days ================= */
function testSkipDays() {
  const r = rows_().find(x => x.ownerEmail === TEST_EMAIL.toLowerCase() && x.status === 'active');
  if (!r) throw new Error('No confirmed (active) will found for ' + TEST_EMAIL);
  r.deadline -= TEST_SKIP_DAYS * DAY_MS;
  save_(r);
  Logger.log('Deadline moved to ' + fmt_(r.deadline, r.timeZone) + '. Now run hourlyCheck.');
}