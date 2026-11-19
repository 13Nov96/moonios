'use strict';
/* 月讀 — 自用 iOS 網頁 App，可匯入靜讀天下（Moon+ Reader）備份 */
const $ = s => document.querySelector(s);
const BOOK_EXT = /\.(epub|pdf|txt)$/i;
const PO_RE = /(\d+)\*(-?\d+)@(-?\d+)#(-?\d+):(-?[\d.]+)%/;
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- IndexedDB ---------- */
let _db;
function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((res, rej) => {
    const q = indexedDB.open('moonios', 1);
    q.onupgradeneeded = () => {
      const d = q.result;
      d.createObjectStore('books', { keyPath: 'id' });
      d.createObjectStore('progress', { keyPath: 'bookId' });
      d.createObjectStore('notes', { keyPath: 'id' }).createIndex('bookId', 'bookId');
      d.createObjectStore('pending', { keyPath: 'key' });
      d.createObjectStore('meta', { keyPath: 'k' });
    };
    q.onsuccess = () => res(_db = q.result);
    q.onerror = () => rej(q.error);
  });
}
async function tx(store, mode, fn) {
  const d = await openDB();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode), s = t.objectStore(store);
    let out; const r = fn(s);
    if (r && 'onsuccess' in r) r.onsuccess = () => { out = r.result; };
    t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
  });
}
const dbAll = (s) => tx(s, 'readonly', st => st.getAll());
const dbGet = (s, k) => tx(s, 'readonly', st => st.get(k));
const dbPut = (s, v) => tx(s, 'readwrite', st => st.put(v));
const dbDel = (s, k) => tx(s, 'readwrite', st => st.delete(k));
const notesOf = (id) => tx('notes', 'readonly', st => st.index('bookId').getAll(id));
async function metaGet(k, d) { const r = await dbGet('meta', k); return r ? r.v : d; }
const metaSet = (k, v) => dbPut('meta', { k, v });
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

/* ---------- utils ---------- */
const baseName = p => String(p || '').split(/[\\/]/).pop();
const keyOf = p => baseName(p).normalize('NFC').toLowerCase().trim();
const looseKey = p => keyOf(p).replace(/\.(epub|pdf|txt|mobi|azw3|fb2|zip|umd)$/, '').replace(/[\s\p{P}\p{S}]+/gu, '');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtOf = n => (n.match(BOOK_EXT) || [, ''])[1].toLowerCase();
function moonColor(c) {
  const n = Number(c); if (!Number.isFinite(n) || n === 0) return 'rgba(255,214,0,.42)';
  const v = n >>> 0; const r = (v >>> 16) & 255, g = (v >>> 8) & 255, b = v & 255;
  return `rgba(${r},${g},${b},.42)`;
}
const solid = c => c.replace(/,\s*[\d.]+\)$/, ',1)').replace('rgba', 'rgba');
function toast(m, ms = 1800) { const t = $('#toast'); t.textContent = m; t.classList.remove('hidden'); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), ms); }
function busy(m) { const b = $('#busy'); if (m) { b.textContent = m; b.classList.remove('hidden'); } else b.classList.add('hidden'); }
function modal(title, html, buttons = [['好', true]]) {
  return new Promise(res => {
    const box = $('#mbox');
    box.innerHTML = `<h3>${esc(title)}</h3><div class="body">${html}</div><div class="acts"></div>`;
    const acts = box.querySelector('.acts');
    buttons.forEach(([label, val, pri]) => {
      const b = document.createElement('button'); b.className = 'btn' + (pri || val === true ? ' pri' : ''); b.textContent = label;
      b.onclick = () => { const inp = box.querySelector('textarea,input'); $('#modal').classList.add('hidden'); res(val === 'input' ? (inp ? inp.value : '') : val); };
      acts.appendChild(b);
    });
    $('#modal').classList.remove('hidden');
    const f = box.querySelector('textarea,input'); if (f) setTimeout(() => f.focus(), 50);
  });
}
async function askText(title, val = '', multi = false) {
  const f = multi ? `<textarea rows="5">${esc(val)}</textarea>` : `<input type="text" value="${esc(val)}">`;
  const r = await modal(title, f, [['取消', null], ['確定', 'input', true]]);
  return r === null ? null : r;
}
function parseXML(s) { return new DOMParser().parseFromString(s, 'application/xml'); }
const byTag = (el, t) => Array.from(el.getElementsByTagNameNS('*', t));
function normPath(p) {
  const out = [];
  for (const seg of p.split('/')) { if (seg === '..') out.pop(); else if (seg && seg !== '.') out.push(seg); }
  return out.join('/');
}
const dirOf = p => p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '';

/* ---------- Text decoding ---------- */
function decodeTxt(buf) {
  const u = new Uint8Array(buf);
  if (u[0] === 0xFF && u[1] === 0xFE) return new TextDecoder('utf-16le').decode(u);
  if (u[0] === 0xFE && u[1] === 0xFF) return new TextDecoder('utf-16be').decode(u);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(u).replace(/^﻿/, ''); } catch (e) {}
  const cand = ['big5', 'gbk'].map(enc => {
    try { const s = new TextDecoder(enc).decode(u); return [s, (s.match(/�/g) || []).length]; } catch (e) { return ['', 1e9]; }
  });
  return cand[0][1] <= cand[1][1] ? cand[0][0] : cand[1][0];
}

/* ---------- Moon+ backup parsing ---------- */
let SQL;
async function sqlInit() { if (!SQL) SQL = await initSqlJs({ locateFile: f => 'vendor/' + f }); return SQL; }
const isSqlite = u => u.length > 16 && String.fromCharCode(...u.slice(0, 15)) === 'SQLite format 3';

function newRec(path) { return { key: keyOf(path), path: String(path || ''), title: '', author: '', shelves: [], pos: null, notes: [], applied: false }; }
function parsePO(s, time) {
  const m = String(s).match(PO_RE); if (!m) return null;
  return { time: +m[1] || time || 0, chapter: +m[2], split: +m[3], pos: +m[4], pct: parseFloat(m[5]) };
}

async function parseMoonZip(zip, report) {
  const recs = new Map(); const books = [];
  const get = (path) => { const k = keyOf(path); if (!recs.has(k)) recs.set(k, newRec(path)); const r = recs.get(k); if (!r.path || r.path.length < String(path).length) r.path = String(path); return r; };
  const files = Object.values(zip.files).filter(f => !f.dir);
  // _names.list → N.tag
  const nameMap = {};
  for (const nl of files.filter(f => /_names\.list$/i.test(f.name))) {
    const dir = dirOf(nl.name);
    (await nl.async('string')).split(/\r?\n/).forEach((line, i) => { if (line.trim()) nameMap[dir + (i + 1) + '.tag'] = line.trim(); });
  }
  report.files = [];
  for (const f of files) {
    const real = nameMap[f.name] || f.name;
    const u = await f.async('uint8array');
    const entry = { zip: f.name, name: real, size: u.length, kind: '' };
    report.files.push(entry);
    if (BOOK_EXT.test(real) && u.length > 200 && !isSqlite(u)) {
      books.push({ name: baseName(real), path: real, blob: new Blob([u]) }); entry.kind = 'book'; continue;
    }
    if (isSqlite(u)) { entry.kind = 'sqlite'; await readMoonDB(u, get, entry, report); continue; }
    if (u.length > 3e6) continue;
    const s = new TextDecoder('utf-8').decode(u);
    if (/\.po$/i.test(real) && PO_RE.test(s)) { const p = parsePO(s); if (p) { setPos(get(real.replace(/\.po$/i, '')), p); entry.kind = 'po'; } continue; }
    if (s.includes('<map') && s.includes('<string')) {
      const doc = parseXML(s); let n = 0;
      for (const el of byTag(doc, 'string')) {
        const k = el.getAttribute('name') || '', v = el.textContent || '';
        if (PO_RE.test(v) && /[./\\]/.test(k)) { const p = parsePO(v); if (p) { setPos(get(k), p); n++; } }
      }
      if (n) { entry.kind = 'positions'; entry.count = n; report.positions = (report.positions || 0) + n; }
    }
  }
  return { recs, books };
}
function setPos(rec, p) { if (!rec.pos || (p.time || 0) >= (rec.pos.time || 0)) rec.pos = p; }

async function readMoonDB(u, get, entry, report) {
  const S = await sqlInit(); const db = new S.Database(u);
  try {
    const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table'")[0]?.values.map(v => v[0]) || [];
    entry.tables = {};
    const rows = (t) => { const r = db.exec(`SELECT * FROM "${t}"`)[0]; if (!r) return []; return r.values.map(v => Object.fromEntries(r.columns.map((c, i) => [c, v[i]]))); };
    for (const t of tables) {
      const cols = db.exec(`PRAGMA table_info("${t}")`)[0]?.values.map(v => v[1]) || [];
      const cnt = db.exec(`SELECT count(*) FROM "${t}"`)[0]?.values[0][0];
      entry.tables[t] = { cols, cnt };
    }
    const pick = (o, ...names) => { for (const n of names) { const hit = Object.keys(o).find(k => k.toLowerCase() === n.toLowerCase()); if (hit && o[hit] != null && o[hit] !== '') return o[hit]; } return undefined; };
    if (tables.includes('books')) {
      for (const r of rows('books')) {
        const fn = pick(r, 'filename', 'lowerFilename'); if (!fn) continue;
        const rec = get(fn);
        rec.title = rec.title || pick(r, 'book') || ''; rec.author = rec.author || pick(r, 'author') || '';
        const cat = pick(r, 'category', 'tags', 'tag');
        if (cat) String(cat).split(/[\n,;|\t]+/).map(s => s.trim()).filter(Boolean).forEach(s => rec.shelves.push(s));
        const fav = pick(r, 'favorite');
        if (fav && fav !== '0' && fav !== 0) rec.shelves.push('★ 最愛');
        report.books = (report.books || 0) + 1;
      }
    }
    if (tables.includes('notes')) {
      for (const r of rows('notes')) {
        const fn = pick(r, 'filename', 'lowerFilename'); if (!fn) continue;
        const rec = get(fn); rec.title = rec.title || pick(r, 'book') || '';
        const len = +pick(r, 'highlightLength') || 0, text = String(pick(r, 'original') || ''), note = String(pick(r, 'note') || '');
        const ul = +pick(r, 'underline') || 0, st = +pick(r, 'strikethrough') || 0;
        rec.notes.push({
          chapter: +pick(r, 'lastChapter') || 0, split: +pick(r, 'lastSplitIndex') || 0, pos: +pick(r, 'lastPosition') || 0,
          len, text, note, color: moonColor(pick(r, 'highlightColor')), style: st ? 'st' : ul ? 'ul' : 'hl',
          type: (len > 0 || text) ? 'hl' : (note ? 'note' : 'bm'), time: +pick(r, 'time') || 0, bm: String(pick(r, 'bookmark') || '')
        });
        report.notes = (report.notes || 0) + 1;
      }
    }
    // other tables that carry positions
    for (const t of tables) {
      if (t === 'books' || t === 'notes') continue;
      const cols = entry.tables[t].cols.map(c => c.toLowerCase());
      if (!cols.some(c => c.includes('filename'))) continue;
      for (const r of rows(t)) {
        const fn = pick(r, 'filename', 'lowerFilename'); if (!fn) continue;
        for (const v of Object.values(r)) if (typeof v === 'string' && PO_RE.test(v)) { const p = parsePO(v); if (p) { setPos(get(fn), p); report.positions = (report.positions || 0) + 1; } }
      }
    }
  } finally { db.close(); }
}

async function savePending(recs) {
  for (const r of recs.values()) {
    if (!r.title && !r.pos && !r.notes.length && !r.shelves.length) continue;
    const old = await dbGet('pending', r.key);
    if (old) {
      r.shelves = [...new Set([...(old.shelves || []), ...r.shelves])];
      if (old.pos && (!r.pos || (old.pos.time || 0) > (r.pos.time || 0))) r.pos = old.pos;
      const sig = n => n.chapter + '|' + n.pos + '|' + n.text + '|' + n.note;
      const seen = new Set(old.notes.map(sig)); r.notes = [...old.notes, ...r.notes.filter(n => !seen.has(sig(n)))];
      r.title = r.title || old.title; r.author = r.author || old.author;
    }
    r.shelves = [...new Set(r.shelves)];
    r.applied = false;
    await dbPut('pending', r);
  }
}

/* apply pending Moon+ records to library books (by file name) */
async function applyPending() {
  const books = await dbAll('books'), pend = await dbAll('pending');
  const exact = new Map(books.map(b => [b.key, b])), loose = new Map(books.map(b => [looseKey(b.name), b]));
  let matched = 0;
  for (const r of pend) {
    if (r.applied) continue;
    const b = exact.get(r.key) || loose.get(looseKey(r.key)) || (r.title && books.find(x => looseKey(x.title) === looseKey(r.title)));
    if (!b) continue;
    b.shelves = [...new Set([...(b.shelves || []), ...r.shelves])];
    if (r.title && (!b.title || b.title === b.name.replace(BOOK_EXT, ''))) b.title = r.title;
    if (r.author && !b.author) b.author = r.author;
    if (r.pos) b.moonPos = r.pos;
    await dbPut('books', b);
    const existing = await notesOf(b.id);
    const sig = n => (n.raw ? n.raw.chapter + '|' + n.raw.pos : '') + '|' + n.text + '|' + n.note;
    const seen = new Set(existing.map(sig));
    for (const n of r.notes) {
      const rec = { id: uid(), bookId: b.id, chapter: n.chapter, start: -1, end: -1, text: n.text, note: n.note, color: n.color, style: n.style, type: n.type, time: n.time, raw: { chapter: n.chapter, split: n.split, pos: n.pos, len: n.len }, unresolved: true };
      if (seen.has(sig(rec))) continue;
      await dbPut('notes', rec);
    }
    r.applied = true; r.bookId = b.id; await dbPut('pending', r); matched++;
  }
  return matched;
}

/* ---------- import ---------- */
async function addBook(name, blob, path) {
  const fmt = fmtOf(name); if (!fmt) return null;
  const key = keyOf(name);
  const all = await dbAll('books');
  if (all.find(b => b.key === key && b.size === blob.size)) return 'dup';
  const b = { id: uid(), key, name: baseName(name), path: path || name, fmt, size: blob.size, blob, title: name.replace(BOOK_EXT, ''), author: '', cover: null, shelves: [], added: Date.now(), lastRead: 0, pct: 0 };
  if (fmt === 'epub') { try { const m = await epubMeta(blob); Object.assign(b, { title: m.title || b.title, author: m.author || '', cover: m.cover }); } catch (e) { console.warn(e); } }
  await dbPut('books', b);
  return b;
}

async function handleFiles(fileList) {
  const files = Array.from(fileList); if (!files.length) return;
  try { navigator.storage && navigator.storage.persist && await navigator.storage.persist(); } catch (e) {}
  const report = { added: 0, dup: 0, books: 0, notes: 0, positions: 0, files: [], errors: [] };
  let anyBackup = false, recsAll = new Map();
  for (let i = 0; i < files.length; i++) {
    const f = files[i]; busy(`處理中 ${i + 1}/${files.length}\n${f.name}`);
    try {
      if (/\.json$/i.test(f.name)) { await importAppBackup(JSON.parse(await f.text())); report.appBackup = true; continue; }
      if (/\.po$/i.test(f.name)) { const p = parsePO(await f.text()); if (p) { const r = newRec(f.name.replace(/\.po$/i, '')); r.pos = p; recsAll.set(r.key, r); report.positions++; } continue; }
      if (BOOK_EXT.test(f.name)) { const r = await addBook(f.name, f); r === 'dup' ? report.dup++ : r && report.added++; continue; }
      // zip-like: .mrpro / .mrstd / .zip
      const zip = await JSZip.loadAsync(f);
      const names = Object.keys(zip.files);
      const isMoon = names.some(n => /_names\.list$|\.tag$|com\.flyersoft/i.test(n));
      if (isMoon) {
        anyBackup = true;
        const { recs, books } = await parseMoonZip(zip, report);
        for (const [k, r] of recs) recsAll.set(k, r);
        for (const b of books) { const r = await addBook(b.name, b.blob, b.path); r === 'dup' ? report.dup++ : r && report.added++; }
      } else {
        for (const n of names) {
          const z = zip.files[n]; if (z.dir || !BOOK_EXT.test(n) || /(^|\/)\./.test(n)) continue;
          if (/\.po$/i.test(n)) continue;
          const r = await addBook(baseName(n), new Blob([await z.async('uint8array')]), n); r === 'dup' ? report.dup++ : r && report.added++;
        }
        for (const n of names.filter(n => /\.po$/i.test(n))) { const p = parsePO(await zip.files[n].async('string')); if (p) { const r = newRec(baseName(n).replace(/\.po$/i, '')); r.pos = p; recsAll.set(r.key, r); report.positions++; } }
      }
    } catch (e) {
      console.error(e);
      report.errors.push(f.name + '：' + (/encrypt/i.test(e.message) ? '備份檔有加密，無法解開' : e.message));
    }
  }
  if (recsAll.size) await savePending(recsAll);
  const matched = await applyPending();
  busy();
  await renderLib();
  await showReport(report, matched, anyBackup);
}

async function showReport(rep, matched, anyBackup) {
  const pend = await dbAll('pending');
  const missing = pend.filter(r => !r.applied && (r.notes.length || r.pos));
  let h = '';
  if (rep.added || rep.dup) h += `<div>書檔：新增 ${rep.added} 本${rep.dup ? `，重複略過 ${rep.dup} 本` : ''}</div>`;
  if (anyBackup) h += `<div>靜讀天下備份：書籍記錄 ${rep.books || 0} 筆、畫線／筆記／書籤 ${rep.notes || 0} 則、閱讀進度 ${rep.positions || 0} 筆</div>`;
  else if (rep.positions) h += `<div>閱讀進度（.po）：${rep.positions} 筆</div>`;
  if (rep.appBackup) h += `<div>已還原月讀備份</div>`;
  h += `<div>本次配對成功：${matched} 本</div>`;
  if (missing.length) h += `<div style="margin-top:8px">尚缺書檔（匯入同名書檔後自動套用）：</div><pre>${esc(missing.slice(0, 80).map(r => '・' + (r.title || baseName(r.path))).join('\n'))}${missing.length > 80 ? '\n…共 ' + missing.length + ' 本' : ''}</pre>`;
  if (rep.errors.length) h += `<div style="color:#c33;margin-top:8px">${rep.errors.map(esc).join('<br>')}</div>`;
  if (anyBackup && rep.files.length) {
    const tech = rep.files.filter(f => f.kind).map(f => `${f.name} [${f.kind}${f.count ? ' ' + f.count : ''}] ${f.size}B` + (f.tables ? '\n  ' + Object.entries(f.tables).map(([t, v]) => `${t}(${v.cnt}): ${v.cols.join(',')}`).join('\n  ') : '')).join('\n');
    h += `<details style="margin-top:8px"><summary>技術資訊</summary><pre id="techinfo">${esc(tech)}</pre><button class="btn" id="copyTech">複製</button></details>`;
  }
  const p = modal('匯入結果', h);
  const c = $('#copyTech'); if (c) c.onclick = () => navigator.clipboard.writeText($('#techinfo').textContent).then(() => toast('已複製'), () => toast('無法複製'));
  await p;
}

/* ---------- EPUB ---------- */
async function zipFileCI(zip, path) {
  path = normPath(decodeURIComponent(path));
  let f = zip.file(path); if (f) return f;
  const low = path.toLowerCase(); const hit = Object.keys(zip.files).find(n => n.toLowerCase() === low);
  return hit ? zip.file(hit) : null;
}
async function epubOpen(blob) {
  const zip = await JSZip.loadAsync(blob);
  const cont = parseXML(await (await zipFileCI(zip, 'META-INF/container.xml')).async('string'));
  const opfPath = byTag(cont, 'rootfile')[0].getAttribute('full-path');
  const base = dirOf(opfPath);
  const opf = parseXML(await (await zipFileCI(zip, opfPath)).async('string'));
  const man = {};
  for (const it of byTag(opf, 'item')) man[it.getAttribute('id')] = { href: normPath(base + it.getAttribute('href')), type: it.getAttribute('media-type') || '', props: it.getAttribute('properties') || '' };
  const spineEl = byTag(opf, 'spine')[0];
  const spine = byTag(opf, 'itemref').map(r => man[r.getAttribute('idref')]).filter(Boolean).map(m => ({ path: m.href.split('#')[0] }));
  const title = byTag(opf, 'title')[0]?.textContent?.trim() || '';
  const author = byTag(opf, 'creator')[0]?.textContent?.trim() || '';
  let coverId = byTag(opf, 'meta').find(m => m.getAttribute('name') === 'cover')?.getAttribute('content');
  let coverItem = Object.values(man).find(m => /cover-image/.test(m.props)) || (coverId && man[coverId]);
  // TOC
  let toc = [];
  try {
    const nav = Object.values(man).find(m => /\bnav\b/.test(m.props));
    if (nav) {
      const d = new DOMParser().parseFromString(await (await zipFileCI(zip, nav.href)).async('string'), 'application/xhtml+xml');
      const navEl = byTag(d, 'nav').find(n => /toc/.test(n.getAttribute('epub:type') || n.getAttributeNS('http://www.idpf.org/2007/ops', 'type') || '')) || byTag(d, 'nav')[0];
      if (navEl) toc = byTag(navEl, 'a').map(a => ({ label: a.textContent.trim(), href: normPath(dirOf(nav.href) + (a.getAttribute('href') || '')), depth: byTag(navEl, 'ol').filter(o => o.contains(a)).length - 1 }));
    }
    if (!toc.length) {
      const ncxId = spineEl?.getAttribute('toc'); const ncx = (ncxId && man[ncxId]) || Object.values(man).find(m => /ncx/.test(m.type));
      if (ncx) {
        const d = parseXML(await (await zipFileCI(zip, ncx.href)).async('string'));
        const walk = (el, depth) => { for (const np of Array.from(el.children).filter(c => c.localName === 'navPoint')) { const lab = byTag(np, 'text')[0]?.textContent.trim() || ''; const src = byTag(np, 'content')[0]?.getAttribute('src') || ''; toc.push({ label: lab, href: normPath(dirOf(ncx.href) + src), depth }); walk(np, depth + 1); } };
        const nm = byTag(d, 'navMap')[0]; if (nm) walk(nm, 0);
      }
    }
  } catch (e) { console.warn('toc', e); }
  toc.forEach(t => { const p = decodeURIComponent(t.href.split('#')[0]); t.chapter = spine.findIndex(s => decodeURIComponent(s.path) === p); t.frag = t.href.split('#')[1] || ''; });
  return { zip, spine, title, author, coverItem, toc: toc.filter(t => t.chapter >= 0) };
}
async function epubMeta(blob) {
  const e = await epubOpen(blob); let cover = null;
  if (e.coverItem) { const f = await zipFileCI(e.zip, e.coverItem.href); if (f) cover = new Blob([await f.async('uint8array')], { type: e.coverItem.type || 'image/jpeg' }); }
  if (!cover && e.spine[0]) {
    try { const html = await (await zipFileCI(e.zip, e.spine[0].path)).async('string'); const m = html.match(/<(?:img[^>]+src|image[^>]+href)\s*=\s*["']([^"']+)/i); if (m) { const f = await zipFileCI(e.zip, dirOf(e.spine[0].path) + m[1]); if (f) cover = new Blob([await f.async('uint8array')]); } } catch (x) {}
  }
  return { title: e.title, author: e.author, cover };
}

/* Book source abstraction: count / title(i) / node(i) / text(i) */
async function makeEpubSource(book) {
  const e = await epubOpen(book.blob); const urls = {}; const texts = [];
  const node = async (i, noImg) => {
    const it = e.spine[i]; const f = await zipFileCI(e.zip, it.path); const raw = f ? await f.async('string') : '';
    let doc = new DOMParser().parseFromString(raw, 'application/xhtml+xml');
    if (doc.getElementsByTagName('parsererror').length) doc = new DOMParser().parseFromString(raw, 'text/html');
    const body = doc.body || doc.getElementsByTagName('body')[0] || doc.documentElement;
    const w = document.createElement('div'); w.className = 'chap';
    for (const c of Array.from(body.childNodes)) w.appendChild(document.importNode(c, true));
    w.querySelectorAll('script,style,link,meta,title,head').forEach(x => x.remove());
    w.querySelectorAll('[style]').forEach(x => x.removeAttribute('style'));
    w.querySelectorAll('[id]').forEach(x => { x.dataset.eid = x.id; x.removeAttribute('id'); });
    if (!noImg) {
      for (const img of w.querySelectorAll('img,image')) {
        const src = img.getAttribute('src') || img.getAttribute('href') || img.getAttributeNS('http://www.w3.org/1999/xlink', 'href'); if (!src || /^data:/.test(src)) continue;
        const p = normPath(dirOf(it.path) + src.split('#')[0]);
        if (!urls[p]) { const ff = await zipFileCI(e.zip, p); if (ff) urls[p] = URL.createObjectURL(new Blob([await ff.async('uint8array')])); }
        if (urls[p]) { if (img.localName === 'img') img.setAttribute('src', urls[p]); else { img.setAttribute('href', urls[p]); img.setAttributeNS('http://www.w3.org/1999/xlink', 'href', urls[p]); } }
      }
    } else w.querySelectorAll('img,image').forEach(x => x.remove());
    w.querySelectorAll('a[href]').forEach(a => { const h = a.getAttribute('href'); if (!/^[a-z]+:/i.test(h)) { a.dataset.ihref = h.startsWith('#') ? it.path + h : normPath(dirOf(it.path) + h); a.removeAttribute('href'); a.setAttribute('role', 'link'); } });
    return w;
  };
  return {
    kind: 'epub', count: e.spine.length, toc: e.toc,
    title: i => (e.toc.filter(t => t.chapter <= i).pop() || {}).label || `第 ${i + 1} 節`,
    node, text: async i => texts[i] ??= (await node(i, true)).textContent,
    resolveHref(h) { const p = decodeURIComponent(h.split('#')[0]); return { chapter: e.spine.findIndex(s => decodeURIComponent(s.path) === p), frag: h.split('#')[1] || '' }; },
    dispose() { Object.values(urls).forEach(u => URL.revokeObjectURL(u)); }
  };
}

async function makeTxtSource(book) {
  const raw = decodeTxt(await book.blob.arrayBuffer()).replace(/\r\n?/g, '\n');
  const head = /^[ \t　]*(第[0-9０-９零〇一二三四五六七八九十百千萬万两兩]+[章回節节卷集部篇話话].{0,40}|序[章言]?|楔子|尾聲|後記|Chapter\s+\d+.{0,40})[ \t　]*$/gm;
  let starts = [0], m; const titles = ['開頭'];
  while ((m = head.exec(raw))) { if (m.index - starts[starts.length - 1] > 200 || starts.length === 1) { if (m.index > 0) { starts.push(m.index); titles.push(m[1].trim()); } else titles[0] = m[1].trim(); } }
  if (starts.length < 3) { starts = [0]; titles.length = 0; titles.push('第 1 段'); }
  // split long chunks
  const s2 = [], t2 = [];
  starts.forEach((s, i) => { const e = starts[i + 1] ?? raw.length; let p = s, k = 0; while (p < e) { let q = Math.min(e, p + 20000); if (q < e) { const nl = raw.indexOf('\n', q); q = nl > 0 && nl < e ? nl + 1 : e; } s2.push(p); t2.push(k++ ? `${titles[i]}（${k}）` : titles[i]); p = q; } });
  const chunks = s2.map((s, i) => raw.slice(s, s2[i + 1] ?? raw.length));
  const node = async i => { const w = document.createElement('div'); w.className = 'chap'; for (const line of chunks[i].split('\n')) { const p = document.createElement('p'); if (line.trim()) p.textContent = line; else p.className = 'blank'; w.appendChild(p); } return w; };
  return {
    kind: 'txt', count: chunks.length, toc: t2.map((label, chapter) => ({ label, chapter, depth: 0 })), title: i => t2[i], node,
    text: async i => chunks[i].replace(/\n/g, ''),
    rawStarts: s2, rawLen: raw.length,
    rawToLocal(g) { let i = s2.length - 1; while (i > 0 && s2[i] > g) i--; const loc = g - s2[i]; return { chapter: i, offset: loc - (chunks[i].slice(0, loc).match(/\n/g) || []).length }; },
    dispose() {}
  };
}

/* ---------- Moon+ data resolution (first open) ---------- */
function normIndex(text) {
  const idx = new Int32Array(text.length); let s = '';
  const parts = []; let n = 0;
  for (let i = 0; i < text.length; i++) { const c = text[i]; if (!/\s/.test(c)) { parts.push(c); idx[n++] = i; } }
  s = parts.join(''); return { s, idx: idx.subarray(0, n) };
}
async function resolveMoon(book, src, notes) {
  const unresolved = notes.filter(n => n.unresolved);
  const needPos = book.moonPos && !book.moonPosApplied;
  if (!unresolved.length && !needPos) return;
  busy('首次開啟：對齊靜讀天下的畫線與進度…');
  const norm = []; const getN = async i => norm[i] ??= normIndex(await src.text(i));
  const deltas = {};
  for (const n of unresolved) {
    const needle = (n.text || '').replace(/\s+/g, '');
    let found = null;
    if (src.kind === 'txt') {
      const g = src.rawToLocal(n.raw.pos);
      const order = [g.chapter, ...Array.from({ length: src.count }, (_, i) => i).filter(i => i !== g.chapter)];
      for (const ch of order) {
        if (!needle) break;
        const N = await getN(ch); let best = -1, bd = Infinity, at = N.s.indexOf(needle.slice(0, 60));
        while (at >= 0) { const d = Math.abs(N.idx[at] - (ch === g.chapter ? g.offset : 0)); if (d < bd) { bd = d; best = at; } at = N.s.indexOf(needle.slice(0, 60), at + 1); }
        if (best >= 0) { const endN = Math.min(N.idx.length - 1, best + needle.length - 1); found = { chapter: ch, start: N.idx[best], end: N.idx[endN] + 1 }; break; }
      }
      if (!found) found = { chapter: g.chapter, start: g.offset, end: g.offset };
    } else {
      const c0 = Math.min(Math.max(0, n.raw.chapter), src.count - 1);
      const order = [c0]; for (let d = 1; d < src.count; d++) { if (c0 + d < src.count) order.push(c0 + d); if (c0 - d >= 0) order.push(c0 - d); }
      if (needle) for (const ch of order) {
        const N = await getN(ch); const probe = needle.slice(0, 60); let best = -1, bd = Infinity, at = N.s.indexOf(probe);
        while (at >= 0) { const d = Math.abs(N.idx[at] - n.raw.pos); if (d < bd) { bd = d; best = at; } at = N.s.indexOf(probe, at + 1); }
        if (best >= 0) { const endN = Math.min(N.idx.length - 1, best + needle.length - 1); found = { chapter: ch, start: N.idx[best], end: N.idx[endN] + 1 }; deltas[ch - n.raw.chapter] = (deltas[ch - n.raw.chapter] || 0) + 1; break; }
      }
      if (!found) { const t = await src.text(c0); const o = Math.min(n.raw.pos, t.length); found = { chapter: c0, start: o, end: o }; }
    }
    Object.assign(n, found, { unresolved: false });
    if (n.type === 'hl' && n.start === n.end) n.lost = true;
    await dbPut('notes', n);
  }
  if (needPos) {
    const p = book.moonPos; let chapter, offset;
    const counts = await charCounts(book, src); const total = counts.reduce((a, b) => a + b, 0) || 1;
    if (src.kind === 'txt') {
      if (p.chapter === 0 && p.pos <= src.rawLen) ({ chapter, offset } = src.rawToLocal(p.pos));
      else ({ chapter, offset } = globalToLocal(counts, p.pct / 100 * total));
    } else {
      const delta = +(Object.entries(deltas).sort((a, b) => b[1] - a[1])[0]?.[0] || 0);
      chapter = Math.min(Math.max(0, p.chapter + delta), src.count - 1);
      offset = p.split === 0 ? Math.min(p.pos, counts[chapter]) : 0;
      const g = counts.slice(0, chapter).reduce((a, b) => a + b, 0) + offset;
      if (p.pct > 0 && Math.abs(g / total * 100 - p.pct) > 15) ({ chapter, offset } = globalToLocal(counts, p.pct / 100 * total));
      else if (p.split > 0 && p.pct > 0) { const want = globalToLocal(counts, p.pct / 100 * total); if (want.chapter === chapter) offset = want.offset; }
    }
    const old = await dbGet('progress', book.id);
    if (!old || (p.time || 0) > (old.time || 0)) await dbPut('progress', { bookId: book.id, chapter, offset, pct: p.pct, time: p.time || Date.now() });
    book.moonPosApplied = true; if (!book.lastRead) book.lastRead = p.time || 0; book.pct = p.pct; await dbPut('books', book);
  }
  busy();
}
function globalToLocal(counts, g) { let ch = 0; while (ch < counts.length - 1 && g >= counts[ch]) { g -= counts[ch]; ch++; } return { chapter: ch, offset: Math.max(0, Math.floor(g)) }; }
async function charCounts(book, src) {
  if (book.counts && book.counts.length === src.count) return book.counts;
  const c = []; for (let i = 0; i < src.count; i++) c.push((await src.text(i)).length);
  book.counts = c; await dbPut('books', book); return c;
}

/* ---------- Library UI ---------- */
let curShelf = '全部', coverURLs = [];
async function renderLib() {
  coverURLs.forEach(u => URL.revokeObjectURL(u)); coverURLs = [];
  const books = await dbAll('books');
  const shelves = new Set(); books.forEach(b => (b.shelves || []).forEach(s => shelves.add(s)));
  const list = ['全部', '閱讀中', ...[...shelves].sort((a, b) => (a.startsWith('★') ? -1 : 0) - (b.startsWith('★') ? -1 : 0) || a.localeCompare(b, 'zh-Hant'))];
  if (!list.includes(curShelf)) curShelf = '全部';
  $('#shelves').innerHTML = list.map(s => `<button class="chip${s === curShelf ? ' on' : ''}" data-s="${esc(s)}">${esc(s)}</button>`).join('');
  const q = $('#search').value.trim().toLowerCase();
  let shown = books.filter(b => curShelf === '全部' || (curShelf === '閱讀中' ? b.pct > 0 && b.pct < 99.5 : (b.shelves || []).includes(curShelf)));
  if (q) shown = shown.filter(b => (b.title + ' ' + b.author + ' ' + b.name).toLowerCase().includes(q));
  shown.sort((a, b) => (b.lastRead || 0) - (a.lastRead || 0) || (b.added - a.added));
  const pend = (await dbAll('pending')).filter(r => !r.applied && (r.notes.length || r.pos)).length;
  $('#notice').innerHTML = pend ? `<div class="notice">靜讀天下還有 ${pend} 本書的進度／畫線在等書檔。把書檔匯入後會自動套用。</div>` : '';
  if (!books.length) {
    $('#grid').innerHTML = `<div class="empty" style="grid-column:1/-1">還沒有書。<br>按「匯入」選擇：<br>靜讀天下備份檔（.mrpro）<br>書檔（EPUB／PDF／TXT，可多選）<br>或整個書資料夾的 .zip</div>`; return;
  }
  const hue = s => [...s].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
  $('#grid').innerHTML = shown.map(b => {
    let img = ''; if (b.cover) { const u = URL.createObjectURL(b.cover); coverURLs.push(u); img = `<img src="${u}" alt="">`; }
    return `<button class="bk" data-id="${b.id}"><div class="cv" style="background:hsl(${hue(b.title)},28%,45%)">${img || `<div class="ph">${esc(b.title)}</div>`}<span class="fmt">${b.fmt.toUpperCase()}</span>${b.pct ? `<div class="pb" style="width:${Math.min(100, b.pct)}%"></div>` : ''}</div><div class="bt">${esc(b.title)}</div><div class="bs">${esc(b.author || '')}${b.pct ? ` ${b.pct.toFixed(1)}%` : ''}</div></button>`;
  }).join('') || `<div class="empty" style="grid-column:1/-1">此書架沒有書</div>`;
}
$('#shelves').onclick = e => { const c = e.target.closest('.chip'); if (c) { curShelf = c.dataset.s; renderLib(); } };
$('#search').oninput = () => renderLib();
$('#bImport').onclick = () => $('#fileIn').click();
$('#fileIn').onchange = e => { handleFiles(e.target.files).finally(() => { e.target.value = ''; }); };
let pressT, pressed = false;
$('#grid').addEventListener('touchstart', e => { const b = e.target.closest('.bk'); if (!b) return; pressed = false; pressT = setTimeout(() => { pressed = true; bookMenu(b.dataset.id); }, 550); }, { passive: true });
['touchend', 'touchmove', 'touchcancel'].forEach(ev => $('#grid').addEventListener(ev, () => clearTimeout(pressT), { passive: true }));
$('#grid').addEventListener('contextmenu', e => { const b = e.target.closest('.bk'); if (b) { e.preventDefault(); if (!pressed) bookMenu(b.dataset.id); } });
$('#grid').onclick = e => { const b = e.target.closest('.bk'); if (!b) return; if (pressed) { pressed = false; return; } openBook(b.dataset.id); };

async function bookMenu(id) {
  const b = await dbGet('books', id); if (!b) return;
  const r = await modal(b.title, `<div>${esc(b.author)}</div><div class="bs">${esc(b.name)}・${(b.size / 1048576).toFixed(1)} MB</div><div style="margin-top:6px">書架：${esc((b.shelves || []).join('、') || '（無）')}</div>`, [['刪除', 'del'], ['書架', 'shelf'], ['改書名', 'title'], ['關閉', null, true]]);
  if (r === 'shelf') { const v = await askText('書架（以逗號分隔）', (b.shelves || []).join(', ')); if (v !== null) { b.shelves = v.split(/[,，、]/).map(s => s.trim()).filter(Boolean); await dbPut('books', b); renderLib(); } }
  if (r === 'title') { const v = await askText('書名', b.title); if (v) { b.title = v; await dbPut('books', b); renderLib(); } }
  if (r === 'del') { if (await modal('刪除這本書？', '書檔、進度與畫線都會刪除。', [['取消', false], ['刪除', true]])) { for (const n of await notesOf(id)) await dbDel('notes', n.id); await dbDel('progress', id); await dbDel('books', id); for (const p of await dbAll('pending')) if (p.bookId === id) { p.applied = false; delete p.bookId; await dbPut('pending', p); } renderLib(); } }
}

$('#bMenu').onclick = async () => {
  let est = ''; try { const e = await navigator.storage.estimate(); est = `已用空間 ${(e.usage / 1048576).toFixed(0)} MB／可用約 ${(e.quota / 1048576 / 1024).toFixed(1)} GB`; } catch (x) {}
  let pers = ''; try { pers = (await navigator.storage.persisted()) ? '資料已設為持久保存' : '尚未取得持久保存（建議從主畫面圖示開啟）'; } catch (x) {}
  const hasPin = !!(await metaGet('pin', null));
  const r = await modal('月讀', `<div>${est}</div><div>${pers}</div><div style="margin-top:8px">匯出：把進度、畫線、書架存成 .json，換手機時在新裝置匯入（書檔需另外匯入）。</div>`, [['清除全部', 'wipe'], ['匯出備份', 'exp'], [hasPin ? '密碼設定' : '設定密碼', 'pin'], ['WiFi 傳書', 'xfer'], ['關閉', null, true]]);
  if (r === 'pin') pinMenu(hasPin);
  if (r === 'xfer') openTransfer();
  if (r === 'exp') exportAppBackup();
  if (r === 'wipe' && await modal('清除全部資料？', '書檔、進度、畫線全部刪除，無法復原。', [['取消', false], ['全部清除', true]])) { _db && _db.close(); _db = null; indexedDB.deleteDatabase('moonios'); setTimeout(() => location.reload(), 300); }
};

async function exportAppBackup() {
  const books = (await dbAll('books')).map(({ blob, cover, counts, ...m }) => m);
  const data = { app: 'moonios', v: 1, at: Date.now(), books, progress: await dbAll('progress'), notes: await dbAll('notes'), pending: await dbAll('pending'), settings: await metaGet('settings', null) };
  const name = `moonios-backup-${new Date().toISOString().slice(0, 10)}.json`;
  const file = new File([JSON.stringify(data)], name, { type: 'application/json' });
  try { if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); return; } } catch (e) { if (e.name === 'AbortError') return; }
  const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}
async function importAppBackup(d) {
  if (d.app !== 'moonios') throw new Error('不是月讀備份檔');
  const lib = await dbAll('books'); const byKey = new Map(lib.map(b => [b.key, b]));
  const idMap = {};
  for (const m of d.books) {
    const b = byKey.get(m.key);
    if (b) { idMap[m.id] = b.id; b.shelves = [...new Set([...(b.shelves || []), ...(m.shelves || [])])]; b.title = m.title || b.title; b.pct = m.pct || b.pct; b.lastRead = Math.max(b.lastRead || 0, m.lastRead || 0); b.moonPosApplied = true; await dbPut('books', b); }
    else { // keep as pending until the book file arrives
      const r = newRec(m.name); r.title = m.title; r.author = m.author; r.shelves = m.shelves || []; r.appBook = m; r.notes = []; await dbPut('pending', r);
    }
  }
  for (const p of d.progress) if (idMap[p.bookId]) await dbPut('progress', { ...p, bookId: idMap[p.bookId] });
  for (const n of d.notes) if (idMap[n.bookId]) await dbPut('notes', { ...n, bookId: idMap[n.bookId] });
  for (const r of d.pending || []) if (!r.applied && !(await dbGet('pending', r.key))) await dbPut('pending', r);
  if (d.settings) await metaSet('settings', d.settings);
}

/* ---------- Reader ---------- */
const R = { book: null, src: null, chapter: 0, notes: [], pdf: null, saveT: 0, settings: null };
const defaults = { fs: 19, lh: 1.8, theme: 'light', ff: 'sans', mg: 20 };
async function loadSettings() { R.settings = { ...defaults, ...(await metaGet('settings', {})) }; applySettings(); }
function applySettings() {
  const s = R.settings, rs = document.documentElement.style;
  rs.setProperty('--fs', s.fs + 'px'); rs.setProperty('--lh', s.lh); rs.setProperty('--mg', s.mg + 'px');
  rs.setProperty('--ff', s.ff === 'serif' ? '"Songti TC","STSong","Noto Serif TC",serif' : '-apple-system,"PingFang TC","Heiti TC",sans-serif');
  document.documentElement.dataset.theme = s.theme;
}

async function openBook(id) {
  const book = await dbGet('books', id); if (!book) return;
  busy('開啟中…');
  try {
    R.book = book; R.notes = await notesOf(id);
    $('#lib').classList.add('hidden'); $('#rd').classList.remove('hidden'); showBars(false);
    $('#rTitle').textContent = book.title;
    if (book.fmt === 'pdf') { await openPdf(book); return; }
    R.src = book.fmt === 'epub' ? await makeEpubSource(book) : await makeTxtSource(book);
    await resolveMoon(book, R.src, R.notes); R.notes = await notesOf(id);
    busy('開啟中…');
    const pr = await dbGet('progress', id) || { chapter: 0, offset: 0 };
    await showChapter(Math.min(pr.chapter, R.src.count - 1), { offset: pr.offset });
    charCounts(book, R.src).then(c => { R.counts = c; updateFooter(); });
  } catch (e) { console.error(e); await modal('無法開啟', esc(e.message)); closeBook(); }
  finally { busy(); }
}
async function closeBook() {
  await saveProgress(true);
  if (R.src) R.src.dispose(); if (R.pdf) { R.pdf.destroy(); R.pdf = null; }
  R.src = null; R.book = null; R.counts = null;
  $('#content').innerHTML = ''; $('#chend').innerHTML = ''; $('#rd').classList.add('hidden'); $('#lib').classList.remove('hidden'); hideSel();
  renderLib();
}
$('#bBack').onclick = closeBook;

async function showChapter(i, { offset = 0, frag = '', end = false, mark = null } = {}) {
  R.chapter = i; R.pdfPage = null;
  const node = await R.src.node(i);
  const c = $('#content'); c.innerHTML = ''; c.appendChild(node);
  paintNotes();
  $('#chend').innerHTML = `${i > 0 ? '<button class="btn" data-go="-1">‹ 上一章</button>' : ''}${i < R.src.count - 1 ? '<button class="btn" data-go="1">下一章 ›</button>' : '<div class="bs" style="text-align:center;flex:1">全書完</div>'}`;
  $('#hdr').textContent = R.src.title(i);
  const pg = $('#page');
  await sleep(0);
  if (end) pg.scrollTop = pg.scrollHeight;
  else if (frag) { const el = c.querySelector(`[data-eid="${CSS.escape(frag)}"]`); pg.scrollTop = el ? el.getBoundingClientRect().top - pg.getBoundingClientRect().top + pg.scrollTop - 30 : 0; }
  else scrollToOffset(offset);
  if (mark) flash(mark);
  updateFooter(); saveProgress();
}
$('#chend').onclick = e => { const b = e.target.closest('[data-go]'); if (b) go(+b.dataset.go); };
async function go(d, end = false) { if (!R.src) { pdfGo(d); return; } const n = R.chapter + d; if (n < 0 || n >= R.src.count) return; await showChapter(n, { end }); }
$('#bPrev').onclick = () => go(-1); $('#bNext').onclick = () => go(1);

function textPoint(root, off) {
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let pos = 0, n, last = null;
  while ((n = w.nextNode())) { if (pos + n.data.length >= off) return [n, off - pos]; pos += n.data.length; last = n; }
  return last ? [last, last.data.length] : null;
}
function offsetOf(root, node, off) { const r = document.createRange(); r.setStart(root, 0); try { r.setEnd(node, off); } catch (e) { return 0; } return r.toString().length; }
function scrollToOffset(off) {
  const pg = $('#page'), c = $('#content');
  if (!off) { pg.scrollTop = 0; return; }
  const p = textPoint(c, off); if (!p) return;
  const r = document.createRange(); r.setStart(p[0], Math.min(p[1], p[0].data.length)); r.setEnd(p[0], Math.min(p[1] + 1, p[0].data.length));
  const rect = r.getClientRects()[0] || p[0].parentElement.getBoundingClientRect();
  pg.scrollTop += rect.top - pg.getBoundingClientRect().top - parseFloat(getComputedStyle(pg).paddingTop) + 4;
}
function currentOffset() {
  const pg = $('#page'), c = $('#content'); const pr = pg.getBoundingClientRect();
  const y = pr.top + parseFloat(getComputedStyle(pg).paddingTop) + 6, x = c.getBoundingClientRect().left + 12;
  let rg = document.caretRangeFromPoint ? document.caretRangeFromPoint(x, y) : null;
  if (rg && c.contains(rg.startContainer)) return offsetOf(c, rg.startContainer, rg.startOffset);
  const w = document.createTreeWalker(c, NodeFilter.SHOW_TEXT); let n;
  while ((n = w.nextNode())) { const r = document.createRange(); r.selectNodeContents(n); const b = r.getBoundingClientRect(); if (b.bottom > y && b.height) return offsetOf(c, n, 0); }
  return 0;
}
function bookPct() {
  if (R.pdf) return (R.pdfPage || 1) / R.pdf.numPages * 100;
  if (!R.counts) return R.book.pct || 0;
  const total = R.counts.reduce((a, b) => a + b, 0) || 1;
  const pg = $('#page'); const within = R.counts[R.chapter] * Math.min(1, pg.scrollTop / Math.max(1, pg.scrollHeight - pg.clientHeight));
  return (R.counts.slice(0, R.chapter).reduce((a, b) => a + b, 0) + within) / total * 100;
}
function updateFooter() {
  const p = bookPct();
  $('#ftr').textContent = R.pdf ? `${R.pdfPage || 1} / ${R.pdf.numPages}` : `${p.toFixed(1)}%`;
  if (!sliding) $('#slider').value = Math.round(p * 10);
}
async function saveProgress(now) {
  if (!R.book) return;
  const doIt = async () => {
    if (!R.book) return;
    const pct = bookPct(); const rec = R.pdf ? { bookId: R.book.id, chapter: (R.pdfPage || 1) - 1, offset: 0, pct, time: Date.now() } : { bookId: R.book.id, chapter: R.chapter, offset: currentOffset(), pct, time: Date.now() };
    await dbPut('progress', rec); R.book.pct = pct; R.book.lastRead = Date.now();
    const b = await dbGet('books', R.book.id); if (b) { b.pct = pct; b.lastRead = R.book.lastRead; if (R.book.counts) b.counts = R.book.counts; await dbPut('books', b); }
  };
  clearTimeout(R.saveT); if (now) await doIt(); else R.saveT = setTimeout(doIt, 800);
}
$('#page').addEventListener('scroll', () => { updateFooter(); saveProgress(); hideBarsOnScroll(); }, { passive: true });
document.addEventListener('visibilitychange', () => { if (document.hidden) { saveProgress(true); if (!xfer.peer) lockIfNeeded(); } });
window.addEventListener('pagehide', () => saveProgress(true));

/* tap zones */
let barsOn = false;
function showBars(v) { barsOn = v; $('#tbar').classList.toggle('hidden', !v); $('#bbar').classList.toggle('hidden', !v); }
function hideBarsOnScroll() { if (barsOn && !sliding) showBars(false); }
$('#page').addEventListener('click', async e => {
  const sel = window.getSelection(); if (sel && !sel.isCollapsed) return;
  const a = e.target.closest('[data-ihref]');
  if (a && R.src) { const t = R.src.resolveHref(a.dataset.ihref); if (t.chapter >= 0) { await showChapter(t.chapter, { frag: t.frag }); } return; }
  const m = e.target.closest('mark[data-nid]'); if (m) { noteMenu(m.dataset.nid); return; }
  if (e.target.closest('.chend')) return;
  const x = e.clientX / window.innerWidth; const pg = $('#page');
  if (barsOn) { showBars(false); return; }
  if (x > 0.3 && x < 0.7) { showBars(true); return; }
  const step = pg.clientHeight - parseFloat(getComputedStyle(pg).paddingTop) - 40;
  if (x >= 0.7) { if (pg.scrollTop + pg.clientHeight >= pg.scrollHeight - 4) go(1); else pg.scrollBy({ top: step }); }
  else { if (pg.scrollTop <= 2) go(-1, true); else pg.scrollBy({ top: -step }); }
});
let sliding = false;
$('#slider').addEventListener('input', () => { sliding = true; const v = $('#slider').value / 10; $('#ftr').textContent = R.pdf ? `${Math.max(1, Math.round(v / 100 * R.pdf.numPages))} / ${R.pdf.numPages}` : v.toFixed(1) + '%'; });
$('#slider').addEventListener('change', async () => {
  const v = $('#slider').value / 10; sliding = false;
  if (R.pdf) { pdfJump(Math.max(1, Math.round(v / 100 * R.pdf.numPages))); return; }
  if (!R.counts) { toast('計算頁數中，請稍後'); return; }
  const total = R.counts.reduce((a, b) => a + b, 0); const t = globalToLocal(R.counts, v / 100 * total);
  if (t.chapter !== R.chapter) await showChapter(t.chapter, { offset: t.offset }); else scrollToOffset(t.offset);
});

/* ---------- notes ---------- */
function paintNotes() {
  const c = $('#content');
  const list = R.notes.filter(n => n.chapter === R.chapter && !n.unresolved && n.end > n.start).sort((a, b) => a.start - b.start);
  for (const n of list) wrapRange(c, n.start, n.end, n);
}
function wrapRange(root, start, end, n) {
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let pos = 0, t; const tg = [];
  while ((t = w.nextNode())) { const L = t.data.length; if (pos + L > start && pos < end) tg.push([t, Math.max(0, start - pos), Math.min(L, end - pos)]); pos += L; if (pos >= end) break; }
  for (const [node, a, b] of tg) {
    if (!node.data.slice(a, b).trim()) continue;
    let x = node; if (a > 0) x = x.splitText(a); if (b - a < x.data.length) x.splitText(b - a);
    const m = document.createElement('mark'); m.dataset.nid = n.id; m.className = (n.style === 'ul' ? 'ul' : n.style === 'st' ? 'st' : '') + (n.note ? ' hasnote' : '');
    m.style.setProperty('--hc', n.color); m.style.setProperty('--hcs', solid(n.color));
    x.parentNode.insertBefore(m, x); m.appendChild(x);
  }
}
function flash(n) { const m = $(`mark[data-nid="${n.id}"]`); const pg = $('#page'); if (m) { pg.scrollTop += m.getBoundingClientRect().top - pg.getBoundingClientRect().top - pg.clientHeight / 3; m.animate([{ opacity: .2 }, { opacity: 1 }], { duration: 400, iterations: 3 }); } else if (n.start >= 0) scrollToOffset(n.start); }

const COLORS = ['rgba(255,214,0,.42)', 'rgba(110,200,90,.42)', 'rgba(80,160,255,.42)', 'rgba(255,120,160,.42)', 'rgba(255,160,40,.42)'];
let selInfo = null;
document.addEventListener('selectionchange', () => {
  if ($('#rd').classList.contains('hidden') || R.pdf) return;
  const s = window.getSelection(); const c = $('#content');
  if (!s || s.isCollapsed || !s.rangeCount || !c.contains(s.anchorNode)) { setTimeout(() => { const s2 = window.getSelection(); if (!s2 || s2.isCollapsed) hideSel(); }, 200); return; }
  const r = s.getRangeAt(0); const start = offsetOf(c, r.startContainer, r.startOffset), end = offsetOf(c, r.endContainer, r.endOffset);
  if (end <= start) return;
  selInfo = { start, end, text: r.toString() };
  const sb = $('#selbar'); sb.innerHTML = COLORS.map(col => `<button class="dot" data-c="${col}" style="background:${solid(col)}"></button>`).join('') + `<button class="btn" data-c="note">筆記</button>`;
  sb.classList.remove('hidden');
});
function hideSel() { $('#selbar').classList.add('hidden'); selInfo = null; }
$('#selbar').addEventListener('click', async e => {
  const b = e.target.closest('[data-c]'); if (!b || !selInfo) return;
  const info = selInfo; let note = '', color = COLORS[0];
  if (b.dataset.c === 'note') { note = await askText('筆記', '', true); if (note === null) return; } else color = b.dataset.c;
  const n = { id: uid(), bookId: R.book.id, chapter: R.chapter, start: info.start, end: info.end, text: info.text, note, color, style: 'hl', type: 'hl', time: Date.now() };
  await dbPut('notes', n); R.notes.push(n); window.getSelection().removeAllRanges(); hideSel(); await rerender();
});
async function rerender() { const top = $('#page').scrollTop; const node = await R.src.node(R.chapter); const c = $('#content'); c.innerHTML = ''; c.appendChild(node); paintNotes(); $('#page').scrollTop = top; }
async function noteMenu(id) {
  const n = R.notes.find(x => x.id === id); if (!n) return; R.menuNote = id;
  const r = await modal('畫線', `<div class="li" style="border:0"><div class="q" style="--c:${solid(n.color)}">${esc(n.text)}</div>${n.note ? `<div class="n">${esc(n.note)}</div>` : ''}</div><div class="seg" style="justify-content:flex-start">${COLORS.map(c => `<button class="dot" data-col="${c}" style="background:${solid(c)}"></button>`).join('')}</div>`, [['刪除', 'del'], ['編輯筆記', 'edit'], ['關閉', null, true]]);
  if (r === 'del') { await dbDel('notes', id); R.notes = R.notes.filter(x => x.id !== id); }
  if (r === 'edit') { const v = await askText('筆記', n.note, true); if (v !== null) { n.note = v; await dbPut('notes', n); } }
  if (r) await rerender();
}
$('#mbox').addEventListener('click', async e => { const d = e.target.closest('[data-col]'); if (!d) return; const nid = R.notes.find(x => x.id === R.menuNote); if (nid) { nid.color = d.dataset.col; await dbPut('notes', nid); $('#mbox .q').style.setProperty('--c', solid(nid.color)); rerender(); } });

$('#bMark').onclick = async () => {
  const n = R.pdf ? { chapter: (R.pdfPage || 1) - 1, start: 0, end: 0, text: `第 ${R.pdfPage || 1} 頁` } : (() => { const o = currentOffset(); return { chapter: R.chapter, start: o, end: o, text: ($('#content').textContent.slice(o, o + 40)) }; })();
  const rec = { id: uid(), bookId: R.book.id, ...n, note: '', color: 'rgba(120,120,120,.4)', style: 'hl', type: 'bm', time: Date.now() };
  await dbPut('notes', rec); R.notes.push(rec); toast('已加入書籤');
};

function openPanel(html) { $('#sheet').innerHTML = html; $('#panel').classList.remove('hidden'); showBars(false); }
$('#panel').onclick = e => { if (e.target.id === 'panel') $('#panel').classList.add('hidden'); };
$('#bToc').onclick = () => {
  if (R.pdf) { openPanel(`<h3>跳至頁</h3><input id="pgIn" type="number" min="1" max="${R.pdf.numPages}" value="${R.pdfPage || 1}" style="font-size:18px;width:120px"> <button class="btn pri" id="pgGo">前往</button>`); $('#pgGo').onclick = () => { $('#panel').classList.add('hidden'); pdfJump(+$('#pgIn').value || 1); }; return; }
  const toc = R.src.toc.length ? R.src.toc : Array.from({ length: R.src.count }, (_, i) => ({ label: R.src.title(i), chapter: i, depth: 0 }));
  openPanel(`<h3>目錄</h3>` + toc.map((t, k) => `<button class="li${t.chapter === R.chapter ? ' cur' : ''}" data-k="${k}" style="padding-left:${4 + (t.depth || 0) * 16}px">${esc(t.label || '（無標題）')}</button>`).join(''));
  $('#sheet').onclick = e => { const b = e.target.closest('[data-k]'); if (!b) return; const t = toc[+b.dataset.k]; $('#panel').classList.add('hidden'); showChapter(t.chapter, { frag: t.frag }); };
  const cur = $('#sheet .cur'); if (cur) cur.scrollIntoView({ block: 'center' });
};
$('#bNotes').onclick = () => {
  const list = R.notes.slice().sort((a, b) => a.chapter - b.chapter || a.start - b.start);
  const label = n => R.pdf ? `第 ${n.chapter + 1} 頁` : (R.src ? R.src.title(n.chapter) : '');
  openPanel(`<h3>筆記與書籤（${list.length}）</h3>` + (list.map(n => `<button class="li" data-id="${n.id}"><div class="q" style="--c:${solid(n.color)}">${n.type === 'bm' ? '🔖 ' : ''}${esc((n.text || '').slice(0, 160)) || '（無文字）'}</div>${n.note ? `<div class="n">${esc(n.note)}</div>` : ''}<div class="m">${esc(label(n))}${n.lost ? '・原文位置未對上' : ''}${n.time ? '・' + new Date(n.time).toLocaleDateString('zh-TW') : ''}</div></button>`).join('') || '<div class="empty">尚無</div>') + (list.length ? `<div style="margin-top:12px"><button class="btn" id="cpNotes">複製全部筆記</button></div>` : ''));
  $('#sheet').onclick = async e => {
    if (e.target.id === 'cpNotes') { const t = `${R.book.title}\n\n` + list.map(n => `◆ ${label(n)}\n${n.text}${n.note ? '\n（' + n.note + '）' : ''}`).join('\n\n'); navigator.clipboard.writeText(t).then(() => toast('已複製'), () => toast('無法複製')); return; }
    const b = e.target.closest('[data-id]'); if (!b) return; const n = R.notes.find(x => x.id === b.dataset.id); $('#panel').classList.add('hidden');
    if (R.pdf) { pdfJump(n.chapter + 1); return; }
    if (n.chapter !== R.chapter) await showChapter(n.chapter, { offset: n.start, mark: n }); else flash(n);
  };
};
$('#bSet').onclick = () => {
  const s = R.settings;
  const seg = (k, opts) => `<div class="seg">${opts.map(([v, l]) => `<button data-k="${k}" data-v="${v}" class="${String(s[k]) === String(v) ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  openPanel(`<h3>閱讀設定</h3>
  <div class="set"><span>字級</span><div class="seg"><button data-act="fs-">A−</button><span style="min-width:36px;text-align:center;align-self:center">${s.fs}</span><button data-act="fs+">A＋</button></div></div>
  <div class="set"><span>行距</span>${seg('lh', [[1.5, '密'], [1.8, '中'], [2.1, '鬆']])}</div>
  <div class="set"><span>邊距</span>${seg('mg', [[12, '窄'], [20, '中'], [32, '寬']])}</div>
  <div class="set"><span>字體</span>${seg('ff', [['sans', '黑體'], ['serif', '明體']])}</div>
  <div class="set"><span>主題</span>${seg('theme', [['light', '白'], ['sepia', '米'], ['dark', '灰'], ['black', '黑']])}</div>`);
  $('#sheet').onclick = async e => {
    const b = e.target.closest('button'); if (!b) return; const off = R.pdf ? 0 : currentOffset();
    if (b.dataset.act === 'fs-') s.fs = Math.max(13, s.fs - 1); else if (b.dataset.act === 'fs+') s.fs = Math.min(32, s.fs + 1); else if (b.dataset.k) s[b.dataset.k] = isNaN(+b.dataset.v) ? b.dataset.v : +b.dataset.v;
    applySettings(); await metaSet('settings', s); if (!R.pdf) { await sleep(30); scrollToOffset(off); } $('#bSet').onclick();
    $('#panel').classList.remove('hidden');
  };
};

/* ---------- PDF ---------- */
let pdfjs;
async function openPdf(book) {
  if (!pdfjs) { pdfjs = await import('./vendor/pdf.min.mjs'); pdfjs.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.mjs'; }
  R.src = null;
  R.pdf = await pdfjs.getDocument({ data: new Uint8Array(await book.blob.arrayBuffer()) }).promise;
  const pr = await dbGet('progress', book.id);
  let page = pr ? pr.chapter + 1 : 1;
  if (!pr && book.moonPos) { const p = book.moonPos; page = p.chapter > 0 && p.chapter < R.pdf.numPages ? p.chapter + 1 : Math.max(1, Math.round(p.pct / 100 * R.pdf.numPages)); }
  for (const n of R.notes.filter(n => n.unresolved)) { n.chapter = Math.min(Math.max(0, n.raw.chapter), R.pdf.numPages - 1); n.unresolved = false; await dbPut('notes', n); }
  const c = $('#content'); c.innerHTML = ''; $('#chend').innerHTML = ''; $('#hdr').textContent = book.title;
  const first = await R.pdf.getPage(1); const vp = first.getViewport({ scale: 1 });
  const W = Math.min(c.clientWidth || window.innerWidth - 40, 900); R.pdfScale = W / vp.width;
  for (let i = 1; i <= R.pdf.numPages; i++) { const d = document.createElement('div'); d.className = 'pdfp'; d.dataset.p = i; d.style.width = W + 'px'; d.style.height = vp.height * R.pdfScale + 'px'; d.innerHTML = `<span class="pn">${i}</span>`; c.appendChild(d); }
  const io = new IntersectionObserver(es => es.forEach(en => { if (en.isIntersecting) renderPdfPage(en.target); }), { root: $('#page'), rootMargin: '600px 0px' });
  c.querySelectorAll('.pdfp').forEach(d => io.observe(d)); R.pdfIO = io;
  await sleep(0); pdfJump(page);
  $('#page').addEventListener('scroll', pdfTrack, { passive: true });
}
async function renderPdfPage(d) {
  if (d.dataset.done || !R.pdf) return; d.dataset.done = 1;
  const page = await R.pdf.getPage(+d.dataset.p); const dpr = Math.min(2, window.devicePixelRatio || 1);
  const vp = page.getViewport({ scale: R.pdfScale * dpr }); const cv = document.createElement('canvas'); cv.width = vp.width; cv.height = vp.height;
  d.prepend(cv); await page.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
}
function pdfTrack() { if (!R.pdf) return; const pg = $('#page'); const y = pg.getBoundingClientRect().top + pg.clientHeight / 3; for (const d of $('#content').children) { const r = d.getBoundingClientRect(); if (r.bottom > y) { R.pdfPage = +d.dataset.p; break; } } updateFooter(); saveProgress(); }
function pdfJump(p) { const d = $(`.pdfp[data-p="${p}"]`); if (d) { const pg = $('#page'); pg.scrollTop += d.getBoundingClientRect().top - pg.getBoundingClientRect().top - 20; R.pdfPage = p; updateFooter(); saveProgress(); } }
function pdfGo(d) { if (R.pdf) pdfJump(Math.min(R.pdf.numPages, Math.max(1, (R.pdfPage || 1) + d))); }

/* ---------- boot ---------- */
(async () => {
  await loadSettings();
  await lockIfNeeded();
  await renderLib();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  if (!standalone && /iPhone|iPad/.test(navigator.userAgent) && !(await metaGet('a2hs', false))) {
    await modal('加到主畫面', '請按 Safari 下方「分享」→「加入主畫面」，之後從主畫面圖示開啟。<br>這樣才能離線使用，書與筆記也才會長期保存在手機裡。', [['知道了', true]]);
    await metaSet('a2hs', true);
  }
})();
window.__moon = { pinSet,  handleFiles, dbAll, openBook, closeBook, R };

/* ---------- 4-digit lock ---------- */
async function pinHash(pin, salt) { const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(salt + ':' + pin)); return Array.from(new Uint8Array(d), b => b.toString(16).padStart(2, '0')).join(''); }
async function pinSet(pin) { if (!pin) { await dbDel('meta', 'pin'); return; } const salt = uid(); await metaSet('pin', { salt, hash: await pinHash(pin, salt) }); }
async function pinCheck(pin) { const p = await metaGet('pin', null); return !p || (await pinHash(pin, p.salt)) === p.hash; }
let lockState = null;
function askPin(title, cancelable) {
  return new Promise(res => {
    lockState = { buf: '', res, cancelable };
    $('#lkT').textContent = title; drawDots();
    $('#pad').querySelector('[data-k="forgot"]').textContent = cancelable ? '取消' : '忘記';
    $('#lock').classList.remove('hidden');
  });
}
function drawDots() { $('#lkDots').querySelectorAll('span').forEach((s, i) => s.classList.toggle('f', i < lockState.buf.length)); }
$('#pad').addEventListener('click', async e => {
  const b = e.target.closest('button'); if (!b || !lockState) return; const st = lockState;
  if (b.dataset.k === 'del') { st.buf = st.buf.slice(0, -1); drawDots(); return; }
  if (b.dataset.k === 'forgot') {
    if (st.cancelable) { $('#lock').classList.add('hidden'); lockState = null; st.res(null); return; }
    if (await modal('忘記密碼', '只能清除全部資料（書、進度、畫線）重新開始，無法復原。', [['取消', false], ['清除全部', true]])) { _db && _db.close(); _db = null; indexedDB.deleteDatabase('moonios'); setTimeout(() => location.reload(), 300); }
    return;
  }
  if (st.buf.length >= 4) return;
  st.buf += b.textContent; drawDots();
  if (st.buf.length === 4) { const v = st.buf; await sleep(120); if (lockState === st) { lockState = null; st.res(v); } }
});
function failShake() { const d = $('#lkDots'); d.classList.remove('shake'); void d.offsetWidth; d.classList.add('shake'); }
let locking = false;
async function lockIfNeeded() {
  if (locking || !(await metaGet('pin', null))) return;
  locking = true; $('#lock').classList.remove('hidden');
  for (;;) { const v = await askPin('輸入密碼', false); if (await pinCheck(v)) break; failShake(); }
  $('#lock').classList.add('hidden'); locking = false;
}
async function pinMenu(hasPin) {
  if (hasPin) {
    const r = await modal('密碼設定', '', [['關閉密碼', 'off'], ['變更密碼', 'chg'], ['取消', null, true]]); if (!r) return;
    const cur = await askPin('輸入目前密碼', true); if (cur === null) return;
    if (!(await pinCheck(cur))) { $('#lock').classList.add('hidden'); toast('密碼錯誤'); return; }
    if (r === 'off') { $('#lock').classList.add('hidden'); await pinSet(''); toast('已關閉密碼'); return; }
  }
  const a = await askPin('設定 4 位數密碼', true); if (a === null) return;
  const b = await askPin('再輸入一次', true); $('#lock').classList.add('hidden'); if (b === null) return;
  if (a !== b) { toast('兩次不一致，未設定'); return; }
  await pinSet(a); toast('已設定密碼');
}

/* ---------- WiFi 傳書 (WebRTC, PeerJS signaling) ---------- */
const xfer = { peer: null, files: [], wake: null };
function peerOpts() { const q = new URLSearchParams(location.search).get('ps'); if (!q) return { debug: 0 }; const [host, port] = q.split(':'); return { host, port: +port || 9000, path: '/', secure: false, debug: 0 }; }
function upURL() { return location.host + location.pathname.replace(/[^/]*$/, '') + 'up'; }
async function openTransfer() {
  if (typeof Peer === 'undefined') { toast('傳書元件載入失敗'); return; }
  closePeer(); xfer.files = [];
  $('#xRx').innerHTML = ''; $('#xUrl').textContent = upURL(); $('#xfer').classList.remove('hidden');
  try { xfer.wake = await navigator.wakeLock?.request('screen'); } catch (e) {}
  startPeer();
}
function startPeer() {
  closePeer();
  const code = String(Math.floor(100000 + Math.random() * 900000));
  $('#xCode').textContent = code.slice(0, 3) + ' ' + code.slice(3); $('#xSt').textContent = '連線中…';
  const peer = new Peer('moonios-' + code, peerOpts()); xfer.peer = peer;
  peer.on('open', () => { $('#xSt').textContent = '等待電腦連線…'; });
  peer.on('error', e => { if (e.type === 'unavailable-id') startPeer(); else $('#xSt').textContent = '連線錯誤：' + (e.type || e.message) + '（請按「換配對碼」重試）'; });
  peer.on('disconnected', () => { if (xfer.peer === peer && !peer.destroyed) peer.reconnect(); });
  peer.on('connection', conn => {
    let cur = null; const batch = [];
    conn.on('open', () => { $('#xSt').textContent = '電腦已連線，等待傳送…'; });
    conn.on('data', async d => {
      if (d instanceof ArrayBuffer || ArrayBuffer.isView(d)) { if (cur) { cur.parts.push(d); cur.got += d.byteLength; if (cur.got - cur.shown > 262144 || cur.got >= cur.size) { cur.shown = cur.got; cur.el.textContent = `${cur.name}　${Math.floor(cur.got / Math.max(1, cur.size) * 100)}%`; } } return; }
      if (!d || typeof d !== 'object') return;
      if (d.t === 'start') { const el = document.createElement('div'); $('#xRx').prepend(el); cur = { name: d.name, size: d.size, parts: [], got: 0, shown: 0, el }; el.textContent = d.name + '　0%'; $('#xSt').textContent = '接收中…'; }
      if (d.t === 'end' && cur) { const f = new File(cur.parts, cur.name); batch.push(f); cur.el.textContent = `✓ ${cur.name}`; conn.send({ t: 'ack', name: cur.name }); cur = null; }
      if (d.t === 'done') {
        $('#xSt').textContent = `收到 ${batch.length} 個檔案，匯入中…`;
        const files = batch.splice(0); conn.send({ t: 'importing' });
        await handleFiles(files);
        conn.send({ t: 'imported', n: files.length });
        $('#xSt').textContent = `已匯入 ${files.length} 個檔案。可繼續傳送。`;
      }
    });
    conn.on('close', () => { if (xfer.peer === peer) $('#xSt').textContent = '電腦已中斷，等待重新連線…'; });
  });
}
function closePeer() { if (xfer.peer) { try { xfer.peer.destroy(); } catch (e) {} xfer.peer = null; } }
$('#xNew').onclick = startPeer;
$('#xClose').onclick = () => { closePeer(); try { xfer.wake && xfer.wake.release(); } catch (e) {} $('#xfer').classList.add('hidden'); renderLib(); };
