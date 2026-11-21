'use strict';
/* 月讀 core: storage, utils, import (Moon+ backup), book sources */
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const BOOK_EXT = /\.(epub|pdf|txt)$/i;
const IMG_EXT = /\.(png|jpe?g|webp|gif|bmp)$/i;
const PO_RE = /(\d+)\*(-?\d+)@(-?\d+)#(-?\d+):(-?[\d.]+)%/;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const raf = () => new Promise(r => requestAnimationFrame(() => r()));

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
const dbAll = s => tx(s, 'readonly', st => st.getAll());
const dbGet = (s, k) => tx(s, 'readonly', st => st.get(k));
const dbPut = (s, v) => tx(s, 'readwrite', st => st.put(v));
const dbDel = (s, k) => tx(s, 'readwrite', st => st.delete(k));
const notesOf = id => tx('notes', 'readonly', st => st.index('bookId').getAll(id));
async function metaGet(k, d) { const r = await dbGet('meta', k); return r ? r.v : d; }
const metaSet = (k, v) => dbPut('meta', { k, v });
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
async function updBook(id, patch) { const b = await dbGet('books', id); if (!b) return null; Object.assign(b, typeof patch === 'function' ? patch(b) || {} : patch); await dbPut('books', b); return b; }

/* ---------- utils ---------- */
const baseName = p => String(p || '').split(/[\\/]/).pop();
const parentDir = p => { const a = String(p || '').split(/[\\/]/).filter(Boolean); return a.length > 1 ? a[a.length - 2] : ''; };
const keyOf = p => baseName(p).normalize('NFC').toLowerCase().trim();
const stripExt = (s, re) => s.replace(re, '');
const looseKey = p => keyOf(p).replace(IMG_EXT, '').replace(/\.(epub|pdf|txt|mobi|azw3|fb2|zip|umd)$/, '').replace(/[\s\p{P}\p{S}]+/gu, '');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtOf = n => (n.match(BOOK_EXT) || [, ''])[1].toLowerCase();
function moonColor(c) {
  const n = Number(c); if (!Number.isFinite(n) || n === 0) return 'rgba(255,214,0,.42)';
  const v = n >>> 0; return `rgba(${(v >>> 16) & 255},${(v >>> 8) & 255},${v & 255},.42)`;
}
const solid = c => String(c).replace(/,\s*[\d.]+\)$/, ',1)');
const hue = s => [...String(s)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);
function fmtDur(ms) { const m = Math.round(ms / 60000); if (m < 60) return m + ' 分'; const h = Math.floor(m / 60); return h + ' 小時' + (m % 60 ? ' ' + (m % 60) + ' 分' : ''); }
function relTime(t) {
  if (!t) return ''; const d = Date.now() - t, m = 60000, h = 60 * m, day = 24 * h;
  if (d < m) return '剛剛'; if (d < h) return Math.floor(d / m) + ' 分鐘前'; if (d < day) return Math.floor(d / h) + ' 小時前';
  if (d < 7 * day) return Math.floor(d / day) + ' 天前'; return new Date(t).toLocaleDateString('zh-TW');
}
const dayKey = (t = Date.now()) => { const d = new Date(t); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
function toast(m, ms = 1800) { const t = $('#toast'); t.textContent = m; t.classList.remove('hidden'); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), ms); }
function busy(m) { const b = $('#busy'); if (m) { b.textContent = m; b.classList.remove('hidden'); } else b.classList.add('hidden'); }
function modal(title, html, buttons = [['好', true]]) {
  return new Promise(res => {
    const box = $('#mbox');
    box.innerHTML = `<h3>${esc(title)}</h3><div class="body">${html}</div><div class="mact"></div>`;
    const acts = box.querySelector('.mact');
    buttons.forEach(([label, val, cls]) => {
      const b = document.createElement('button'); b.className = 'btn ' + (cls || (val === true ? 'pri' : '')); b.textContent = label;
      b.onclick = () => { const inp = box.querySelector('textarea,input[type=text]'); $('#modal').classList.add('hidden'); res(val === 'input' ? (inp ? inp.value : '') : val); };
      acts.appendChild(b);
    });
    $('#modal').classList.remove('hidden');
    const f = box.querySelector('textarea,input[type=text]'); if (f) setTimeout(() => f.focus(), 50);
  });
}
async function askText(title, val = '', multi = false) {
  const f = multi ? `<textarea rows="5">${esc(val)}</textarea>` : `<input type="text" value="${esc(val)}">`;
  return modal(title, f, [['取消', null], ['確定', 'input', 'pri']]);
}
const confirmBox = (t, h, ok = '確定', cls = 'pri') => modal(t, h, [['取消', false], [ok, true, cls]]);
function parseXML(s) { return new DOMParser().parseFromString(s, 'application/xml'); }
const byTag = (el, t) => Array.from(el.getElementsByTagNameNS('*', t));
function normPath(p) { const out = []; for (const seg of p.split('/')) { if (seg === '..') out.pop(); else if (seg && seg !== '.') out.push(seg); } return out.join('/'); }
const dirOf = p => p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '';
function pickFile(input, opts = {}) {
  return new Promise(res => { const el = $(input); if (opts.accept !== undefined) el.accept = opts.accept; el.value = ''; el.onchange = () => res(Array.from(el.files)); el.click(); });
}

/* ---------- history layers (back gesture / back button) ---------- */
const layers = [];
function pushLayer(name, close) { layers.push({ name, close }); try { history.pushState({ layer: name, n: layers.length }, ''); } catch (e) {} }
function backLayer(name) { const top = layers[layers.length - 1]; if (top && (!name || top.name === name)) history.back(); }
function dropLayer(name) { const i = layers.map(l => l.name).lastIndexOf(name); if (i >= 0) { const [l] = layers.splice(i, 1); l.close && l.close(); } }
window.addEventListener('popstate', () => { const l = layers.pop(); if (l && l.close) l.close(); });
const topLayer = () => layers[layers.length - 1]?.name;

/* ---------- text decoding & conversion ---------- */
function decodeTxt(buf) {
  const u = new Uint8Array(buf);
  if (u[0] === 0xFF && u[1] === 0xFE) return new TextDecoder('utf-16le').decode(u);
  if (u[0] === 0xFE && u[1] === 0xFF) return new TextDecoder('utf-16be').decode(u);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(u).replace(/^﻿/, ''); } catch (e) {}
  const cand = ['big5', 'gbk'].map(enc => { try { const s = new TextDecoder(enc).decode(u); return [s, (s.match(/�/g) || []).length]; } catch (e) { return ['', 1e9]; } });
  return cand[0][1] <= cand[1][1] ? cand[0][0] : cand[1][0];
}
let _occ = null;
async function converter(mode) {
  if (!mode || mode === 'none') return null;
  if (!window.OpenCC) await new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'vendor/opencc-full.js'; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
  _occ = _occ || {};
  return _occ[mode] ||= mode === 's2t' ? OpenCC.Converter({ from: 'cn', to: 'tw' }) : OpenCC.Converter({ from: 'tw', to: 'cn' });
}
function convertNode(root, fn) {
  if (!fn) return; const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let n;
  while ((n = w.nextNode())) { const c = fn(n.data); if (c.length === n.data.length) n.data = c; }
}

/* ---------- Moon+ backup parsing ---------- */
let SQL;
async function sqlInit() { if (!SQL) SQL = await initSqlJs({ locateFile: f => 'vendor/' + f }); return SQL; }
const isSqlite = u => u.length > 16 && String.fromCharCode(...u.slice(0, 15)) === 'SQLite format 3';
function newRec(path) { return { key: keyOf(path), path: String(path || ''), title: '', author: '', shelves: [], favorite: false, folder: parentDir(path), pos: null, notes: [], cover: null, coverPath: '', applied: false }; }
function parsePO(s, time) { const m = String(s).match(PO_RE); if (!m) return null; return { time: +m[1] || time || 0, chapter: +m[2], split: +m[3], pos: +m[4], pct: parseFloat(m[5]) }; }
function setPos(rec, p) { if (!rec.pos || (p.time || 0) >= (rec.pos.time || 0)) rec.pos = p; }

async function parseMoonZip(zip, report) {
  const recs = new Map(), books = [], images = new Map(), imagesLoose = new Map();
  const get = path => { const k = keyOf(path); if (!recs.has(k)) recs.set(k, newRec(path)); const r = recs.get(k); if (String(path).length > r.path.length) { r.path = String(path); r.folder = parentDir(path); } return r; };
  const files = Object.values(zip.files).filter(f => !f.dir);
  const nameMap = {};
  for (const nl of files.filter(f => /_names\.list$/i.test(f.name))) {
    const dir = dirOf(nl.name);
    (await nl.async('string')).split(/\r?\n/).forEach((line, i) => { if (line.trim()) nameMap[dir + (i + 1) + '.tag'] = line.trim(); });
  }
  report.files = report.files || [];
  for (const f of files) {
    const real = nameMap[f.name] || f.name;
    const u = await f.async('uint8array');
    const entry = { zip: f.name, name: real, size: u.length, kind: '' }; report.files.push(entry);
    if (BOOK_EXT.test(real) && u.length > 200 && !isSqlite(u)) { books.push({ name: baseName(real), path: real, blob: new Blob([u]) }); entry.kind = 'book'; continue; }
    if (IMG_EXT.test(real) && u.length > 100) {
      const ext = (real.match(IMG_EXT) || [])[1] || 'png'; const blob = new Blob([u], { type: 'image/' + (ext === 'jpg' ? 'jpeg' : ext) });
      const k = keyOf(real); images.set(k, blob); images.set(k.replace(IMG_EXT, ''), blob); imagesLoose.set(looseKey(real), blob);
      entry.kind = 'image'; report.images = (report.images || 0) + 1; continue;
    }
    if (isSqlite(u)) { entry.kind = 'sqlite'; await readMoonDB(u, get, entry, report); continue; }
    if (u.length > 3e6) continue;
    const s = new TextDecoder('utf-8').decode(u);
    if (/\.po$/i.test(real) && PO_RE.test(s)) { const p = parsePO(s); if (p) { setPos(get(real.replace(/\.po$/i, '')), p); entry.kind = 'po'; } continue; }
    if (s.includes('<map') && s.includes('<string')) {
      const doc = parseXML(s); let n = 0;
      for (const el of byTag(doc, 'string')) { const k = el.getAttribute('name') || '', v = el.textContent || ''; if (PO_RE.test(v) && /[./\\]/.test(k)) { const p = parsePO(v); if (p) { setPos(get(k), p); n++; } } }
      if (n) { entry.kind = 'positions'; entry.count = n; report.positions = (report.positions || 0) + n; }
    }
  }
  // attach covers
  for (const r of recs.values()) {
    const cands = [];
    if (r.coverPath) cands.push(keyOf(r.coverPath), keyOf(r.coverPath).replace(IMG_EXT, ''));
    cands.push(r.key, r.key.replace(BOOK_EXT, ''));
    let blob = null; for (const c of cands) if (images.has(c)) { blob = images.get(c); break; }
    if (!blob) blob = (r.coverPath && imagesLoose.get(looseKey(r.coverPath))) || imagesLoose.get(looseKey(r.key)) || null;
    if (blob) { r.cover = blob; report.covers = (report.covers || 0) + 1; }
  }
  return { recs, books };
}

async function readMoonDB(u, get, entry, report) {
  const S = await sqlInit(); const db = new S.Database(u);
  try {
    const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table'")[0]?.values.map(v => v[0]) || [];
    entry.tables = {};
    const rows = t => { const r = db.exec(`SELECT * FROM "${t}"`)[0]; if (!r) return []; return r.values.map(v => Object.fromEntries(r.columns.map((c, i) => [c, v[i]]))); };
    for (const t of tables) entry.tables[t] = { cols: db.exec(`PRAGMA table_info("${t}")`)[0]?.values.map(v => v[1]) || [], cnt: db.exec(`SELECT count(*) FROM "${t}"`)[0]?.values[0][0] };
    const pick = (o, ...names) => { for (const n of names) { const hit = Object.keys(o).find(k => k.toLowerCase() === n.toLowerCase()); if (hit && o[hit] != null && o[hit] !== '') return o[hit]; } return undefined; };
    if (tables.includes('books')) for (const r of rows('books')) {
      const fn = pick(r, 'filename', 'lowerFilename'); if (!fn) continue;
      const rec = get(fn);
      rec.title = rec.title || pick(r, 'book') || ''; rec.author = rec.author || pick(r, 'author') || '';
      const cat = pick(r, 'category', 'tags', 'tag');
      if (cat) String(cat).split(/[\n,;|\t]+/).map(s => s.trim()).filter(Boolean).forEach(s => rec.shelves.push(s));
      const fav = pick(r, 'favorite'); if (fav && fav !== '0' && fav !== 0) rec.favorite = true;
      const cov = pick(r, 'coverFile', 'thumbFile', 'cover'); if (cov) rec.coverPath = String(cov);
      const added = pick(r, 'addTime'); if (added && +added > 1e11) rec.added = +added;
      report.books = (report.books || 0) + 1;
    }
    if (tables.includes('notes')) for (const r of rows('notes')) {
      const fn = pick(r, 'filename', 'lowerFilename'); if (!fn) continue;
      const rec = get(fn); rec.title = rec.title || pick(r, 'book') || '';
      const len = +pick(r, 'highlightLength') || 0, text = String(pick(r, 'original') || ''), note = String(pick(r, 'note') || '');
      const ul = +pick(r, 'underline') || 0, st = +pick(r, 'strikethrough') || 0;
      rec.notes.push({ chapter: +pick(r, 'lastChapter') || 0, split: +pick(r, 'lastSplitIndex') || 0, pos: +pick(r, 'lastPosition') || 0, len, text, note, color: moonColor(pick(r, 'highlightColor')), style: st ? 'st' : ul ? 'ul' : 'hl', type: (len > 0 || text) ? 'hl' : (note ? 'note' : 'bm'), time: +pick(r, 'time') || 0 });
      report.notes = (report.notes || 0) + 1;
    }
    for (const t of tables) {
      if (t === 'books' || t === 'notes') continue;
      if (!entry.tables[t].cols.some(c => c.toLowerCase().includes('filename'))) continue;
      for (const r of rows(t)) { const fn = pick(r, 'filename', 'lowerFilename'); if (!fn) continue; for (const v of Object.values(r)) if (typeof v === 'string' && PO_RE.test(v)) { const p = parsePO(v); if (p) { setPos(get(fn), p); report.positions = (report.positions || 0) + 1; } } }
    }
  } finally { db.close(); }
}

async function savePending(recs) {
  for (const r of recs.values()) {
    if (!r.title && !r.pos && !r.notes.length && !r.shelves.length && !r.cover && !r.favorite) continue;
    const old = await dbGet('pending', r.key);
    if (old) {
      r.shelves = [...new Set([...(old.shelves || []), ...r.shelves])];
      if (old.pos && (!r.pos || (old.pos.time || 0) > (r.pos.time || 0))) r.pos = old.pos;
      const sig = n => n.chapter + '|' + n.pos + '|' + n.text + '|' + n.note;
      const seen = new Set(old.notes.map(sig)); r.notes = [...old.notes, ...r.notes.filter(n => !seen.has(sig(n)))];
      r.title = r.title || old.title; r.author = r.author || old.author; r.cover = r.cover || old.cover; r.favorite = r.favorite || old.favorite; r.folder = r.folder || old.folder;
    }
    r.shelves = [...new Set(r.shelves)].filter(s => s !== '★ 最愛'); r.applied = false;
    await dbPut('pending', r);
  }
}
async function applyPending() {
  const books = await dbAll('books'), pend = await dbAll('pending');
  const exact = new Map(books.map(b => [b.key, b])), loose = new Map(books.map(b => [looseKey(b.name), b]));
  let matched = 0;
  for (const r of pend) {
    if (r.applied) continue;
    const b = exact.get(r.key) || loose.get(looseKey(r.key)) || (r.title && books.find(x => looseKey(x.title) === looseKey(r.title)));
    if (!b) continue;
    b.shelves = [...new Set([...(b.shelves || []), ...(r.shelves || [])])];
    if (r.title && (!b.title || b.title === b.name.replace(BOOK_EXT, ''))) b.title = r.title;
    if (r.author && !b.author) b.author = r.author;
    if (r.favorite) b.favorite = true;
    if (r.folder && !b.folder) b.folder = r.folder;
    if (r.cover && !b.coverCustom) { b.cover = r.cover; b.coverMoon = true; b.coverV = Date.now(); }
    if (r.added && (!b.addedMoon)) { b.added = r.added; b.addedMoon = true; }
    if (r.pos) b.moonPos = r.pos;
    if (r.appBook) Object.assign(b, { title: r.appBook.title || b.title, favorite: r.appBook.favorite || b.favorite, pct: r.appBook.pct || b.pct, lastRead: r.appBook.lastRead || b.lastRead, readMs: r.appBook.readMs || b.readMs, finished: r.appBook.finished || b.finished, moonPosApplied: true });
    await dbPut('books', b);
    const existing = await notesOf(b.id);
    const sig = n => (n.raw ? n.raw.chapter + '|' + n.raw.pos : '') + '|' + n.text + '|' + n.note;
    const seen = new Set(existing.map(sig));
    for (const n of r.notes || []) {
      const rec = { id: uid(), bookId: b.id, chapter: n.chapter, start: -1, end: -1, text: n.text, note: n.note, color: n.color, style: n.style, type: n.type, time: n.time, raw: { chapter: n.chapter, split: n.split, pos: n.pos, len: n.len }, unresolved: true };
      if (!seen.has(sig(rec))) await dbPut('notes', rec);
    }
    if (r.appNotes) for (const n of r.appNotes) await dbPut('notes', { ...n, bookId: b.id });
    if (r.appProgress) await dbPut('progress', { ...r.appProgress, bookId: b.id });
    r.applied = true; r.bookId = b.id; await dbPut('pending', r); matched++;
  }
  return matched;
}

/* ---------- import ---------- */
async function pdfCover(blob) {
  try {
    const pdfjs = await loadPdfjs();
    const doc = await pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
    const pg = await doc.getPage(1); const vp0 = pg.getViewport({ scale: 1 }); const vp = pg.getViewport({ scale: 360 / vp0.width });
    const cv = document.createElement('canvas'); cv.width = vp.width; cv.height = vp.height;
    await pg.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise; doc.destroy();
    return await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.82));
  } catch (e) { console.warn('pdf cover', e); return null; }
}
let _pdfjs;
async function loadPdfjs() { if (!_pdfjs) { _pdfjs = await import('../vendor/pdf.min.mjs'); _pdfjs.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.mjs'; } return _pdfjs; }

async function addBook(name, blob, path) {
  const fmt = fmtOf(name); if (!fmt) return null;
  const key = keyOf(name);
  const all = await dbAll('books');
  if (all.find(b => b.key === key && b.size === blob.size)) return 'dup';
  const b = { id: uid(), key, name: baseName(name), path: path || name, folder: parentDir(path || ''), fmt, size: blob.size, blob, title: name.replace(BOOK_EXT, ''), author: '', cover: null, shelves: [], favorite: false, added: Date.now(), lastRead: 0, pct: 0, readMs: 0 };
  if (fmt === 'epub') { try { const m = await epubMeta(blob); Object.assign(b, { title: m.title || b.title, author: m.author || '', cover: m.cover }); } catch (e) { console.warn(e); } }
  if (fmt === 'pdf') b.cover = await pdfCover(blob);
  await dbPut('books', b);
  return b;
}

async function handleFiles(fileList) {
  const files = Array.from(fileList); if (!files.length) return;
  try { navigator.storage && navigator.storage.persist && await navigator.storage.persist(); } catch (e) {}
  const report = { added: 0, dup: 0, books: 0, notes: 0, positions: 0, covers: 0, images: 0, files: [], errors: [] };
  let anyBackup = false; const recsAll = new Map();
  for (let i = 0; i < files.length; i++) {
    const f = files[i]; busy(`處理中 ${i + 1}/${files.length}\n${f.name}`);
    try {
      if (/\.json$/i.test(f.name)) { await importAppBackup(JSON.parse(await f.text())); report.appBackup = true; continue; }
      if (/\.po$/i.test(f.name)) { const p = parsePO(await f.text()); if (p) { const r = newRec(f.name.replace(/\.po$/i, '')); r.pos = p; recsAll.set(r.key, r); report.positions++; } continue; }
      if (/\.(ttf|otf|woff2?)$/i.test(f.name)) { await addFont(f); report.fonts = (report.fonts || 0) + 1; continue; }
      if (BOOK_EXT.test(f.name)) { const r = await addBook(f.name, f, f.webkitRelativePath || f.name); r === 'dup' ? report.dup++ : r && report.added++; continue; }
      const zip = await JSZip.loadAsync(f);
      const names = Object.keys(zip.files);
      if (names.some(n => /_names\.list$|\.tag$|com\.flyersoft/i.test(n))) {
        anyBackup = true;
        const { recs, books } = await parseMoonZip(zip, report);
        for (const [k, r] of recs) recsAll.set(k, r);
        for (const b of books) { const r = await addBook(b.name, b.blob, b.path); r === 'dup' ? report.dup++ : r && report.added++; }
      } else {
        for (const n of names) {
          const z = zip.files[n]; if (z.dir || !BOOK_EXT.test(n) || /(^|\/)[._]/.test(n)) continue;
          const r = await addBook(baseName(n), new Blob([await z.async('uint8array')]), n); r === 'dup' ? report.dup++ : r && report.added++;
        }
        for (const n of names.filter(n => /\.po$/i.test(n))) { const p = parsePO(await zip.files[n].async('string')); if (p) { const r = newRec(baseName(n).replace(/\.po$/i, '')); r.pos = p; recsAll.set(r.key, r); report.positions++; } }
      }
    } catch (e) { console.error(e); report.errors.push(f.name + '：' + (/encrypt/i.test(e.message) ? '備份檔有加密，無法解開' : e.message)); }
  }
  if (recsAll.size) await savePending(recsAll);
  const matched = await applyPending();
  busy();
  if (window.renderLib) await renderLib();
  return showReport(report, matched, anyBackup);
}
async function showReport(rep, matched, anyBackup) {
  const pend = await dbAll('pending'); const missing = pend.filter(r => !r.applied && (r.notes.length || r.pos));
  let h = '';
  if (rep.added || rep.dup) h += `<div>書檔：新增 ${rep.added} 本${rep.dup ? `，重複略過 ${rep.dup} 本` : ''}</div>`;
  if (anyBackup) h += `<div>靜讀天下備份：書籍 ${rep.books || 0}、畫線／筆記／書籤 ${rep.notes || 0}、閱讀進度 ${rep.positions || 0}、封面 ${rep.covers || 0}</div>`;
  else if (rep.positions) h += `<div>閱讀進度（.po）：${rep.positions} 筆</div>`;
  if (rep.fonts) h += `<div>字型：新增 ${rep.fonts} 個</div>`;
  if (rep.appBackup) h += `<div>已還原月讀備份</div>`;
  if (anyBackup || rep.added) h += `<div>本次配對：${matched} 本</div>`;
  if (anyBackup && !rep.covers) h += `<div style="color:var(--sub);font-size:12px;margin-top:4px">備份中沒有封面圖。要搬舊封面，請在靜讀天下備份時勾選「書籍封面」。</div>`;
  if (missing.length) h += `<div style="margin-top:8px">尚缺書檔（匯入同名書檔後自動套用）：</div><pre>${esc(missing.slice(0, 80).map(r => '・' + (r.title || baseName(r.path))).join('\n'))}${missing.length > 80 ? '\n…共 ' + missing.length + ' 本' : ''}</pre>`;
  if (rep.errors.length) h += `<div style="color:#d33;margin-top:8px">${rep.errors.map(esc).join('<br>')}</div>`;
  if (anyBackup && rep.files.length) {
    const tech = rep.files.filter(f => f.kind && f.kind !== 'image').map(f => `${f.name} [${f.kind}${f.count ? ' ' + f.count : ''}] ${f.size}B` + (f.tables ? '\n  ' + Object.entries(f.tables).map(([t, v]) => `${t}(${v.cnt}): ${v.cols.join(',')}`).join('\n  ') : '')).join('\n') + (rep.images ? `\n圖片檔 ${rep.images} 個` : '');
    h += `<details style="margin-top:8px"><summary>技術資訊</summary><pre id="techinfo">${esc(tech)}</pre><button class="btn" id="copyTech">複製</button></details>`;
  }
  if (!h) h = '沒有可匯入的檔案。';
  const p = modal('匯入結果', h);
  const c = $('#copyTech'); if (c) c.onclick = () => navigator.clipboard.writeText($('#techinfo').textContent).then(() => toast('已複製'), () => toast('無法複製'));
  return p;
}

/* ---------- app backup ---------- */
async function exportAppBackup() {
  const books = (await dbAll('books')).map(({ blob, cover, counts, ...m }) => m);
  const data = { app: 'moonios', v: 3, at: Date.now(), books, progress: await dbAll('progress'), notes: await dbAll('notes'), pending: (await dbAll('pending')).map(({ cover, ...r }) => r), settings: await metaGet('settings', null), daily: await metaGet('daily', {}) };
  const name = `moonios-backup-${dayKey()}.json`;
  const file = new File([JSON.stringify(data)], name, { type: 'application/json' });
  try { if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); return; } } catch (e) { if (e.name === 'AbortError') return; }
  const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}
async function importAppBackup(d) {
  if (d.app !== 'moonios') throw new Error('不是月讀備份檔');
  const lib = await dbAll('books'); const byKey = new Map(lib.map(b => [b.key, b])); const idMap = {};
  for (const m of d.books) {
    const b = byKey.get(m.key);
    if (b) { idMap[m.id] = b.id; Object.assign(b, { shelves: [...new Set([...(b.shelves || []), ...(m.shelves || [])])], title: m.title || b.title, author: m.author || b.author, favorite: m.favorite || b.favorite, pct: m.pct || b.pct, lastRead: Math.max(b.lastRead || 0, m.lastRead || 0), readMs: Math.max(b.readMs || 0, m.readMs || 0), finished: m.finished || b.finished, moonPosApplied: true }); await dbPut('books', b); }
    else {
      const r = newRec(m.name); Object.assign(r, { title: m.title, author: m.author, shelves: m.shelves || [], favorite: !!m.favorite, folder: m.folder || '', appBook: m });
      r.appNotes = d.notes.filter(n => n.bookId === m.id).map(({ bookId, ...n }) => n); r.appProgress = d.progress.find(p => p.bookId === m.id) || null;
      if (r.appProgress) delete r.appProgress.bookId;
      await dbPut('pending', r);
    }
  }
  for (const p of d.progress) if (idMap[p.bookId]) await dbPut('progress', { ...p, bookId: idMap[p.bookId] });
  for (const n of d.notes) if (idMap[n.bookId]) await dbPut('notes', { ...n, bookId: idMap[n.bookId] });
  for (const r of d.pending || []) if (!r.applied && !(await dbGet('pending', r.key))) await dbPut('pending', r);
  if (d.settings) await metaSet('settings', d.settings);
  if (d.daily) { const cur = await metaGet('daily', {}); for (const [k, v] of Object.entries(d.daily)) cur[k] = Math.max(cur[k] || 0, v); await metaSet('daily', cur); }
}

/* ---------- fonts ---------- */
async function addFont(file) {
  const fonts = await metaGet('fonts', []);
  const name = file.name.replace(/\.(ttf|otf|woff2?)$/i, '');
  const id = 'uf' + Date.now().toString(36);
  fonts.push({ id, name, blob: file }); await metaSet('fonts', fonts); await loadFonts();
  return id;
}
let fontsLoaded = new Set();
async function loadFonts() {
  const fonts = await metaGet('fonts', []);
  for (const f of fonts) {
    if (fontsLoaded.has(f.id)) continue;
    try { const ff = new FontFace(f.id, await f.blob.arrayBuffer()); await ff.load(); document.fonts.add(ff); fontsLoaded.add(f.id); } catch (e) { console.warn('font', e); }
  }
  return fonts;
}

/* ---------- EPUB ---------- */
async function zipFileCI(zip, path) {
  path = normPath(decodeURIComponent(path));
  const f = zip.file(path); if (f) return f;
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
  const coverId = byTag(opf, 'meta').find(m => m.getAttribute('name') === 'cover')?.getAttribute('content');
  const coverItem = Object.values(man).find(m => /cover-image/.test(m.props)) || (coverId && man[coverId]);
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
        const walk = (el, depth) => { for (const np of Array.from(el.children).filter(c => c.localName === 'navPoint')) { toc.push({ label: byTag(np, 'text')[0]?.textContent.trim() || '', href: normPath(dirOf(ncx.href) + (byTag(np, 'content')[0]?.getAttribute('src') || '')), depth }); walk(np, depth + 1); } };
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
    w.querySelectorAll('[class]').forEach(x => x.removeAttribute('class'));
    if (!noImg) {
      for (const img of w.querySelectorAll('img,image')) {
        const src = img.getAttribute('src') || img.getAttribute('href') || img.getAttributeNS('http://www.w3.org/1999/xlink', 'href'); if (!src || /^data:/.test(src)) continue;
        const p = normPath(dirOf(it.path) + src.split('#')[0]);
        if (!urls[p]) { const ff = await zipFileCI(e.zip, p); if (ff) urls[p] = URL.createObjectURL(new Blob([await ff.async('uint8array')])); }
        if (urls[p]) { if (img.localName === 'img') img.setAttribute('src', urls[p]); else { img.setAttribute('href', urls[p]); img.setAttributeNS('http://www.w3.org/1999/xlink', 'href', urls[p]); } }
      }
    } else w.querySelectorAll('img,image').forEach(x => x.remove());
    w.querySelectorAll('a[href]').forEach(a => { const h = a.getAttribute('href'); if (!/^[a-z]+:/i.test(h)) { a.dataset.ihref = h.startsWith('#') ? it.path + h : normPath(dirOf(it.path) + h); a.removeAttribute('href'); a.setAttribute('role', 'link'); } else { a.setAttribute('target', '_blank'); } });
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
  const head = /^[ \t　]*(第[0-9０-９零〇一二三四五六七八九十百千萬万两兩]+[章回節节卷集部篇話话].{0,40}|序[章言]?|楔子|尾聲|後記|番外.{0,30}|Chapter\s+\d+.{0,40})[ \t　]*$/gm;
  let starts = [0], m; const titles = ['開頭'];
  while ((m = head.exec(raw))) { if (m.index > 0 && m.index - starts[starts.length - 1] > 200) { starts.push(m.index); titles.push(m[1].trim()); } else if (m.index === 0) titles[0] = m[1].trim(); }
  if (starts.length < 3) { starts = [0]; titles.length = 0; titles.push('第 1 段'); }
  const s2 = [], t2 = [];
  starts.forEach((s, i) => { const e = starts[i + 1] ?? raw.length; let p = s, k = 0; while (p < e) { let q = Math.min(e, p + 20000); if (q < e) { const nl = raw.indexOf('\n', q); q = nl > 0 && nl < e ? nl + 1 : e; } s2.push(p); t2.push(k++ ? `${titles[i]}（${k}）` : titles[i]); p = q; } });
  const chunks = s2.map((s, i) => raw.slice(s, s2[i + 1] ?? raw.length));
  const node = async i => { const w = document.createElement('div'); w.className = 'chap'; for (const line of chunks[i].split('\n')) { const p = document.createElement('p'); if (line.trim()) p.textContent = line.replace(/^[ \t　]+/, ''); else p.className = 'blank'; w.appendChild(p); } return w; };
  const texts = [];
  return {
    kind: 'txt', count: chunks.length, toc: t2.map((label, chapter) => ({ label, chapter, depth: 0 })), title: i => t2[i], node,
    text: async i => texts[i] ??= (await node(i)).textContent, rawStarts: s2, rawLen: raw.length,
    rawToLocal(g) {
      let i = s2.length - 1; while (i > 0 && s2[i] > g) i--;
      const loc = Math.max(0, g - s2[i]); const before = chunks[i].slice(0, loc);
      const lead = (before.match(/(^|\n)[ \t　]+/g) || []).reduce((a, x) => a + x.replace('\n', '').length, 0);
      return { chapter: i, offset: Math.max(0, loc - (before.match(/\n/g) || []).length - lead) };
    },
    dispose() {}
  };
}

/* ---------- Moon+ data resolution (first open) ---------- */
function normIndex(text) { const idx = new Int32Array(text.length); const parts = []; let n = 0; for (let i = 0; i < text.length; i++) { const c = text[i]; if (!/\s/.test(c)) { parts.push(c); idx[n++] = i; } } return { s: parts.join(''), idx: idx.subarray(0, n) }; }
function globalToLocal(counts, g) { let ch = 0; while (ch < counts.length - 1 && g >= counts[ch]) { g -= counts[ch]; ch++; } return { chapter: ch, offset: Math.max(0, Math.floor(g)) }; }
async function charCounts(book, src) {
  if (book.counts && book.counts.length === src.count) return book.counts;
  const c = []; for (let i = 0; i < src.count; i++) c.push((await src.text(i)).length);
  book.counts = c; await updBook(book.id, { counts: c }); return c;
}
async function resolveMoon(book, src, notes) {
  const unresolved = notes.filter(n => n.unresolved);
  const needPos = book.moonPos && !book.moonPosApplied;
  if (!unresolved.length && !needPos) return;
  busy('首次開啟：對齊靜讀天下的畫線與進度…');
  const norm = []; const getN = async i => norm[i] ??= normIndex(await src.text(i));
  const deltas = {};
  const findIn = async (ch, needle, near) => {
    const N = await getN(ch); const probe = needle.slice(0, 60); let best = -1, bd = Infinity, at = N.s.indexOf(probe);
    while (at >= 0) { const d = Math.abs(N.idx[at] - near); if (d < bd) { bd = d; best = at; } at = N.s.indexOf(probe, at + 1); }
    if (best < 0) return null; const endN = Math.min(N.idx.length - 1, best + needle.length - 1);
    return { chapter: ch, start: N.idx[best], end: N.idx[endN] + 1 };
  };
  for (const n of unresolved) {
    const needle = (n.text || '').replace(/\s+/g, ''); let found = null;
    if (src.kind === 'txt') {
      const g = src.rawToLocal(n.raw.pos);
      if (needle) for (const ch of [g.chapter, ...Array.from({ length: src.count }, (_, i) => i).filter(i => i !== g.chapter)]) { found = await findIn(ch, needle, ch === g.chapter ? g.offset : 0); if (found) break; }
      if (!found) found = { chapter: g.chapter, start: g.offset, end: g.offset };
    } else {
      const c0 = Math.min(Math.max(0, n.raw.chapter), src.count - 1);
      const order = [c0]; for (let d = 1; d < src.count; d++) { if (c0 + d < src.count) order.push(c0 + d); if (c0 - d >= 0) order.push(c0 - d); }
      if (needle) for (const ch of order) { found = await findIn(ch, needle, n.raw.pos); if (found) { deltas[ch - n.raw.chapter] = (deltas[ch - n.raw.chapter] || 0) + 1; break; } }
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
    await updBook(book.id, b => ({ moonPosApplied: true, lastRead: b.lastRead || p.time || 0, pct: p.pct, finished: p.pct >= 99.5 }));
    book.moonPosApplied = true;
  }
  busy();
}
