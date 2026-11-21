'use strict';
/* 月讀 reader (閱讀器) */
const R = { book: null, src: null, chapter: 0, notes: [], pdf: null, counts: null, settings: null, page: 0, pages: 1, step: 0, paged: false, conv: null, saveT: 0, lastOff: 0 };
const DEFAULTS = { mode: 'page', fs: 19, lh: 1.8, ps: 0.5, indent: true, mg: 22, ff: 'sans', rt: 'light', nightRt: 'black', night: false, ta: 'justify', conv: 'none', tap: 'lr', anim: true, bright: 1, awake: true, ui: 'auto', guideSeen: false, ttsRate: 1, ttsVoice: '', autoSpeed: 3 };
const THEMES = [['light', '#fbfaf6', '白'], ['sepia', '#f3e9d2', '羊皮'], ['green', '#d9ead3', '護眼'], ['paper', '#ece7dc', '紙張'], ['gray', '#3a3b3d', '灰'], ['dark', '#1b1c1e', '暗'], ['black', '#000', '黑']];
const FONTS = [['sans', '蘋方', '-apple-system,"PingFang TC","Heiti TC",sans-serif'], ['serif', '宋體', '"Songti TC","STSong","Noto Serif TC",serif'], ['kai', '楷體', '"Kaiti TC","STKaiti","BiauKai","DFKai-SB",serif'], ['round', '圓體', '"Yuanti TC","PingFang TC",sans-serif']];
async function loadSettings() { R.settings = { ...DEFAULTS, ...(await metaGet('settings', {})) }; applySettings(); applyUITheme(); }
const saveSettings = () => metaSet('settings', R.settings);
function applyUITheme() {
  const ui = R.settings.ui || 'auto';
  document.documentElement.dataset.theme = ui === 'auto' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : ui;
}
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => R.settings && applyUITheme());
function applySettings() {
  const s = R.settings, rs = document.documentElement.style;
  rs.setProperty('--fs', s.fs + 'px'); rs.setProperty('--lh', s.lh); rs.setProperty('--mg', s.mg + 'px'); rs.setProperty('--ps', s.ps + 'em');
  rs.setProperty('--ind', s.indent ? '2em' : '0'); rs.setProperty('--ta', s.ta);
  const f = FONTS.find(x => x[0] === s.ff); rs.setProperty('--ff', f ? f[2] : `"${s.ff}",-apple-system,"PingFang TC",sans-serif`);
  $('#rd').dataset.rt = s.night ? s.nightRt : s.rt;
  $('#dim').style.opacity = String(Math.min(0.75, Math.max(0, 1 - s.bright)));
  $('#nightLbl').textContent = s.night ? '日間' : '夜間';
}

/* ---------- open / close ---------- */
async function openBook(id) {
  const book = await dbGet('books', id); if (!book) return;
  busy('開啟中…');
  try {
    R.book = book; R.notes = await notesOf(id); R.counts = null;
    $('#lib').classList.add('hidden'); $('#rd').classList.remove('hidden'); showBars(false);
    pushLayer('reader', () => closeBook());
    $('#rTitle').textContent = book.title;
    await loadFonts();
    if (book.fmt === 'pdf') { await openPdf(book); afterOpen(); return; }
    R.src = book.fmt === 'epub' ? await makeEpubSource(book) : await makeTxtSource(book);
    await resolveMoon(book, R.src, R.notes); R.notes = await notesOf(id); busy('開啟中…');
    R.conv = await converter(R.settings.conv).catch(() => null);
    const pr = await dbGet('progress', id) || { chapter: 0, offset: 0 };
    await showChapter(Math.min(pr.chapter, R.src.count - 1), { offset: pr.offset });
    charCounts(book, R.src).then(c => { R.counts = c; updateFooter(); });
    afterOpen();
  } catch (e) { console.error(e); busy(); await modal('無法開啟', esc(e.message)); backLayer('reader'); }
  finally { busy(); }
}
async function afterOpen() {
  R.openedAt = Date.now(); touchActive();
  if (R.settings.awake) wakeOn();
  if (!R.settings.guideSeen && !R.pdf) { $('#guide').classList.remove('hidden'); R.settings.guideSeen = true; saveSettings(); }
}
async function closeBook() {
  await saveProgress(true); ttsStop(); autoStop(); wakeOff();
  if (R.src) R.src.dispose(); if (R.pdf) { try { R.pdf.destroy(); } catch (e) {} R.pdf = null; $('#page').removeEventListener('scroll', pdfTrack); }
  R.src = null; R.book = null; R.counts = null;
  $('#content').innerHTML = ''; $('#content').style.transform = ''; $('#chend').innerHTML = '';
  $('#rd').classList.add('hidden'); $('#lib').classList.remove('hidden'); hideSel(); $('#guide').classList.add('hidden'); $('#ctl').classList.add('hidden');
  renderLib();
}
$('#bBack').onclick = () => backLayer('reader');
$('#guide').onclick = () => $('#guide').classList.add('hidden');
let wake = null;
async function wakeOn() { try { wake = await navigator.wakeLock?.request('screen'); } catch (e) {} }
function wakeOff() { try { wake && wake.release(); } catch (e) {} wake = null; }
document.addEventListener('visibilitychange', () => { if (!document.hidden && R.book && R.settings.awake) wakeOn(); });

/* ---------- layout ---------- */
const pg = () => $('#page'), ct = () => $('#content');
function pads() { const cs = getComputedStyle(pg()); return { l: parseFloat(cs.paddingLeft), r: parseFloat(cs.paddingRight), t: parseFloat(cs.paddingTop), b: parseFloat(cs.paddingBottom) }; }
function layout() {
  R.paged = R.settings.mode === 'page' && !R.pdf;
  const rd = $('#rd'); rd.classList.toggle('paged', R.paged); rd.classList.toggle('scroll', !R.paged);
  if (!R.paged) { ct().style.transform = ''; return; }
  const p = pads(), w = pg().clientWidth, h = pg().clientHeight;
  const pw = Math.floor(w - p.l - p.r), lhPx = R.settings.fs * R.settings.lh;
  let ph = Math.floor(h - p.t - p.b); ph = Math.max(lhPx * 3, Math.floor(ph / lhPx) * lhPx);
  const gap = p.l + p.r;
  const rs = document.documentElement.style; rs.setProperty('--pw', pw + 'px'); rs.setProperty('--ph', ph + 'px'); rs.setProperty('--gap', gap + 'px');
  R.step = pw + gap;
}
function countPages() { if (!R.paged) return 1; const sw = ct().scrollWidth; R.pages = Math.max(1, Math.round((sw + parseFloat(getComputedStyle(ct()).columnGap || 0)) / R.step)); return R.pages; }
function goPage(p, anim) {
  R.page = Math.max(0, Math.min(R.pages - 1, p));
  const c = ct(); c.classList.toggle('anim', !!anim && R.settings.anim);
  c.style.transform = `translate3d(${-R.page * R.step}px,0,0)`;
  updateFooter(); saveProgress();
}
function textPoint(root, off) {
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let pos = 0, n, last = null;
  while ((n = w.nextNode())) { if (pos + n.data.length > off) return [n, off - pos]; pos += n.data.length; last = n; }
  return last ? [last, last.data.length] : null;
}
function offsetOf(root, node, off) { const r = document.createRange(); r.setStart(root, 0); try { r.setEnd(node, off); } catch (e) { return 0; } return r.toString().length; }
function rectAt(off) {
  const p = textPoint(ct(), off); if (!p) return null;
  const r = document.createRange(); const a = Math.min(p[1], p[0].data.length); r.setStart(p[0], a); r.setEnd(p[0], Math.min(a + 1, p[0].data.length));
  return r.getClientRects()[0] || p[0].parentElement.getBoundingClientRect();
}
function pageOfOffset(off) { if (!off) return 0; const rc = rectAt(off); if (!rc) return 0; const x = rc.left - ct().getBoundingClientRect().left; return Math.max(0, Math.min(R.pages - 1, Math.floor((x + 2) / R.step))); }
function pageOfEl(el) { const x = el.getBoundingClientRect().left - ct().getBoundingClientRect().left; return Math.max(0, Math.min(R.pages - 1, Math.floor((x + 2) / R.step))); }
function scrollToOffset(off) {
  if (R.paged) { goPage(pageOfOffset(off)); return; }
  if (!off) { pg().scrollTop = 0; return; }
  const rc = rectAt(off); if (!rc) return;
  pg().scrollTop += rc.top - pg().getBoundingClientRect().top - pads().t + 4;
}
function visibleBox() { const r = pg().getBoundingClientRect(), p = pads(); return { l: r.left + p.l, t: r.top + p.t, r: r.right - p.r, b: r.bottom - p.b }; }
function currentOffset() {
  if (!R.src || !ct().firstChild) return 0;
  const v = visibleBox(), c = ct();
  const tries = [[v.l + 3, v.t + 4], [v.l + 30, v.t + 4], [v.l + 3, v.t + R.settings.fs * R.settings.lh * 1.2]];
  for (const [x, y] of tries) {
    const rg = document.caretRangeFromPoint ? document.caretRangeFromPoint(x, y) : null;
    if (rg && c.contains(rg.startContainer) && rg.startContainer.nodeType === 3) return offsetOf(c, rg.startContainer, rg.startOffset);
  }
  const w = document.createTreeWalker(c, NodeFilter.SHOW_TEXT); let n;
  while ((n = w.nextNode())) {
    if (!n.data.trim()) continue; const r = document.createRange(); r.selectNodeContents(n);
    for (const b of r.getClientRects()) if (b.width && b.bottom > v.t && b.right > v.l && b.left < v.r && b.top < v.b) return offsetOf(c, n, 0);
  }
  return 0;
}

/* ---------- chapters ---------- */
async function buildChapter(i) {
  const node = await R.src.node(i); convertNode(node, R.conv);
  node.querySelectorAll('img').forEach(img => img.addEventListener('load', relayoutSoon, { once: true }));
  return node;
}
async function showChapter(i, { offset = 0, frag = '', end = false, flash = null, mark = null } = {}) {
  R.chapter = i;
  const node = await buildChapter(i);
  const c = ct(); c.classList.remove('anim'); c.style.transform = ''; c.innerHTML = ''; c.appendChild(node);
  paintNotes();
  $('#chend').innerHTML = `${i > 0 ? '<button class="btn" data-go="-1">‹ 上一章</button>' : ''}${i < R.src.count - 1 ? '<button class="btn" data-go="1">下一章 ›</button>' : '<div style="text-align:center;flex:1;opacity:.6">全書完</div>'}`;
  $('#hdr').textContent = R.src.title(i);
  layout(); await raf(); countPages();
  if (R.paged) {
    let p = 0;
    if (end) p = R.pages - 1;
    else if (frag) { const el = c.querySelector(`[data-eid="${CSS.escape(frag)}"]`); p = el ? pageOfEl(el) : 0; }
    else if (flash) p = pageOfOffset(flash.start);
    else p = pageOfOffset(offset);
    goPage(p, false);
  } else {
    if (end) pg().scrollTop = pg().scrollHeight;
    else if (frag) { const el = c.querySelector(`[data-eid="${CSS.escape(frag)}"]`); pg().scrollTop = el ? el.getBoundingClientRect().top - pg().getBoundingClientRect().top + pg().scrollTop - 30 : 0; }
    else scrollToOffset(flash ? flash.start : offset);
  }
  if (flash) flashRange(flash.start, flash.end);
  if (mark) flashNote(mark);
  R.lastOff = currentOffset(); updateFooter(); saveProgress();
}
let relT = 0;
function relayoutSoon() { clearTimeout(relT); relT = setTimeout(relayout, 120); }
async function relayout() {
  if (!R.src || !R.book) return; const off = R.lastOff;
  layout(); await raf(); countPages(); if (R.paged) goPage(pageOfOffset(off)); else scrollToOffset(off);
}
async function rerender() { if (!R.src) return; const off = currentOffset(); await showChapter(R.chapter, { offset: off }); }
window.addEventListener('resize', () => { if (R.book && !R.pdf) { R.lastOff = currentOffset(); relayoutSoon(); } });
$('#chend').onclick = e => { const b = e.target.closest('[data-go]'); if (b) goChapter(+b.dataset.go); };
async function goChapter(d, end = false) { if (!R.src) return; const n = R.chapter + d; if (n < 0 || n >= R.src.count) { toast(d > 0 ? '已是最後一章' : '已是第一章'); return; } await showChapter(n, { end }); }
$('#bPrev').onclick = () => goChapter(-1); $('#bNext').onclick = () => goChapter(1);
async function nextPage() {
  touchActive();
  if (R.pdf) { pg().scrollBy({ top: pg().clientHeight * 0.9, behavior: R.settings.anim ? 'smooth' : 'auto' }); return; }
  if (R.paged) { if (R.page < R.pages - 1) goPage(R.page + 1, true); else if (R.chapter < R.src.count - 1) await showChapter(R.chapter + 1); else toast('全書完'); return; }
  const p = pg(); if (p.scrollTop + p.clientHeight >= p.scrollHeight - 4) { if (R.chapter < R.src.count - 1) await showChapter(R.chapter + 1); else toast('全書完'); }
  else p.scrollBy({ top: p.clientHeight - pads().t - pads().b - R.settings.fs * R.settings.lh, behavior: R.settings.anim ? 'smooth' : 'auto' });
}
async function prevPage() {
  touchActive();
  if (R.pdf) { pg().scrollBy({ top: -pg().clientHeight * 0.9, behavior: R.settings.anim ? 'smooth' : 'auto' }); return; }
  if (R.paged) { if (R.page > 0) goPage(R.page - 1, true); else if (R.chapter > 0) await showChapter(R.chapter - 1, { end: true }); return; }
  const p = pg(); if (p.scrollTop <= 2) { if (R.chapter > 0) await showChapter(R.chapter - 1, { end: true }); }
  else p.scrollBy({ top: -(p.clientHeight - pads().t - pads().b - R.settings.fs * R.settings.lh), behavior: R.settings.anim ? 'smooth' : 'auto' });
}

/* ---------- progress / status ---------- */
function bookPct() {
  if (R.pdf) return (R.pdfPage || 1) / R.pdf.numPages * 100;
  if (!R.counts) return R.book?.pct || 0;
  const total = R.counts.reduce((a, b) => a + b, 0) || 1;
  const frac = R.paged ? (R.pages > 1 ? R.page / (R.pages - 1) : 0) : Math.min(1, pg().scrollTop / Math.max(1, pg().scrollHeight - pg().clientHeight));
  return Math.min(100, (R.counts.slice(0, R.chapter).reduce((a, b) => a + b, 0) + R.counts[R.chapter] * frac) / total * 100);
}
function updateFooter() {
  if (!R.book) return; const p = bookPct();
  $('#fPos').textContent = R.pdf ? `${R.pdfPage || 1} / ${R.pdf.numPages}` : (R.paged ? `${R.page + 1}/${R.pages}　` : '') + p.toFixed(1) + '%';
  if (!sliding) { $('#slider').value = Math.round(p * 10); $('#sliderLbl').textContent = R.pdf ? `第 ${R.pdfPage || 1} 頁` : `${R.src?.title(R.chapter) || ''}　${p.toFixed(1)}%`; }
}
function clock() { const d = new Date(); $('#fClock').textContent = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }
setInterval(clock, 20000); clock();
async function saveProgress(now) {
  if (!R.book) return;
  const doIt = async () => {
    if (!R.book) return;
    const pct = bookPct();
    const rec = R.pdf ? { bookId: R.book.id, chapter: (R.pdfPage || 1) - 1, offset: 0, pct, time: Date.now() } : { bookId: R.book.id, chapter: R.chapter, offset: (R.lastOff = currentOffset()), pct, time: Date.now() };
    await dbPut('progress', rec); R.book.pct = pct; R.book.lastRead = Date.now();
    await updBook(R.book.id, b => ({ pct, lastRead: R.book.lastRead, finished: b.finished || pct >= 99.5 }));
  };
  clearTimeout(R.saveT); if (now) await doIt(); else R.saveT = setTimeout(doIt, 700);
}
$('#page').addEventListener('scroll', () => { if (R.paged) { pg().scrollTop = 0; pg().scrollLeft = 0; return; } updateFooter(); saveProgress(); if (barsOn && !sliding) showBars(false); }, { passive: true });
document.addEventListener('visibilitychange', () => { if (document.hidden) saveProgress(true); });
window.addEventListener('pagehide', () => saveProgress(true));

/* ---------- stats ---------- */
let lastActive = 0;
function touchActive() { lastActive = Date.now(); }
setInterval(async () => {
  if (!R.book || document.hidden || Date.now() - lastActive > 180000) return;
  const add = 15000; R.book.readMs = (R.book.readMs || 0) + add;
  await updBook(R.book.id, b => ({ readMs: (b.readMs || 0) + add }));
  const d = await metaGet('daily', {}); d[dayKey()] = (d[dayKey()] || 0) + add; await metaSet('daily', d);
}, 15000);

/* ---------- bars ---------- */
let barsOn = false;
function showBars(v) { barsOn = v; $('#tbar').classList.toggle('off', !v); $('#bbar').classList.toggle('off', !v); if (v) updateFooter(); }
let sliding = false;
$('#slider').addEventListener('input', () => {
  sliding = true; const v = $('#slider').value / 10;
  if (R.pdf) { $('#sliderLbl').textContent = `第 ${Math.max(1, Math.round(v / 100 * R.pdf.numPages))} 頁`; return; }
  if (R.counts) { const t = globalToLocal(R.counts, v / 100 * R.counts.reduce((a, b) => a + b, 0)); $('#sliderLbl').textContent = `${R.src.title(t.chapter)}　${v.toFixed(1)}%`; }
});
$('#slider').addEventListener('change', async () => {
  const v = $('#slider').value / 10; sliding = false;
  if (R.pdf) { pdfJump(Math.max(1, Math.round(v / 100 * R.pdf.numPages))); return; }
  if (!R.counts) { toast('計算頁數中，請稍候'); return; }
  const t = globalToLocal(R.counts, v / 100 * R.counts.reduce((a, b) => a + b, 0));
  if (t.chapter !== R.chapter) await showChapter(t.chapter, { offset: t.offset }); else scrollToOffset(t.offset);
});

/* ---------- touch: tap zones, swipe, brightness, edge-back ---------- */
let G = null, suppressClick = 0;
const page = $('#page');
page.addEventListener('touchstart', e => {
  if (e.touches.length !== 1) { G = null; return; }
  const t = e.touches[0]; const sel = window.getSelection();
  G = { x0: t.clientX, y0: t.clientY, t0: Date.now(), mode: t.clientX < 26 ? 'edge' : 'pending', b0: R.settings.bright, hasSel: sel && !sel.isCollapsed, dx: 0, dy: 0 };
}, { passive: true });
page.addEventListener('touchmove', e => {
  if (!G || G.hasSel) return; const t = e.touches[0]; G.dx = t.clientX - G.x0; G.dy = t.clientY - G.y0;
  const ax = Math.abs(G.dx), ay = Math.abs(G.dy);
  if (G.mode === 'edge') {
    if (ay > 14 && ay > ax) G.mode = 'bright'; else if (ax > 14 && ax > ay) G.mode = R.paged ? 'drag' : 'back';
  }
  if (G.mode === 'pending' && (ax > 10 || ay > 10)) G.mode = (R.paged && ax > ay && Date.now() - G.t0 < 400) ? 'drag' : 'none';
  if (G.mode === 'bright') {
    e.preventDefault(); R.settings.bright = Math.max(0.25, Math.min(1, G.b0 - G.dy / (window.innerHeight * 0.7)));
    $('#dim').style.opacity = String(1 - R.settings.bright); bubble('亮度 ' + Math.round(R.settings.bright * 100) + '%');
  }
  if (G.mode === 'drag') { e.preventDefault(); const c = ct(); c.classList.remove('anim'); let dx = G.dx; if ((R.page === 0 && dx > 0 && R.chapter === 0) || (R.page === R.pages - 1 && dx < 0 && R.chapter === R.src.count - 1)) dx /= 3; c.style.transform = `translate3d(${-R.page * R.step + dx}px,0,0)`; }
}, { passive: false });
page.addEventListener('touchend', async () => {
  if (!G) return; const g = G; G = null;
  if (g.mode === 'bright') { suppressClick = Date.now(); saveSettings(); return; }
  if (g.mode === 'back') { suppressClick = Date.now(); if (g.dx > 70) backLayer('reader'); return; }
  if (g.mode === 'drag') {
    suppressClick = Date.now();
    if (g.x0 < 26 && g.dx > 90 && R.page === 0 && R.chapter === 0) { backLayer('reader'); return; }
    if (g.dx < -45) { if (R.page < R.pages - 1) goPage(R.page + 1, true); else { await nextPage(); } }
    else if (g.dx > 45) { if (R.page > 0) goPage(R.page - 1, true); else await prevPage(); }
    else goPage(R.page, true);
    touchActive();
  }
}, { passive: true });
let bubT;
function bubble(t) { const b = $('#bubble'); b.textContent = t; b.classList.remove('hidden'); clearTimeout(bubT); bubT = setTimeout(() => b.classList.add('hidden'), 700); }
page.addEventListener('click', async e => {
  if (Date.now() - suppressClick < 320) return;
  const sel = window.getSelection(); if (sel && !sel.isCollapsed) return;
  if (T.on) { ttsToggle(); return; }
  if (A.on) { autoToggle(); return; }
  const a = e.target.closest('[data-ihref]');
  if (a && R.src) { const t = R.src.resolveHref(a.dataset.ihref); if (t.chapter >= 0) await showChapter(t.chapter, { frag: t.frag }); return; }
  const m = e.target.closest('mark[data-nid]'); if (m && !barsOn) { noteMenu(m.dataset.nid); return; }
  if (e.target.closest('.chend')) return;
  if (barsOn) { showBars(false); return; }
  const x = e.clientX / window.innerWidth;
  if (x > 0.3 && x < 0.7) { showBars(true); return; }
  if (x >= 0.7 || R.settings.tap === 'next') nextPage(); else prevPage();
});
document.addEventListener('keydown', e => {
  if (!R.book || $('#modal').classList.contains('hidden') === false || topLayer() === 'panel') return;
  if (['ArrowRight', 'ArrowDown', 'PageDown', ' '].includes(e.key)) { e.preventDefault(); nextPage(); }
  if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(e.key)) { e.preventDefault(); prevPage(); }
});

/* ---------- notes & selection ---------- */
function paintNotes() {
  const c = ct();
  R.notes.filter(n => n.chapter === R.chapter && !n.unresolved && n.end > n.start).sort((a, b) => a.start - b.start).forEach(n => wrapRange(c, n.start, n.end, n));
}
function wrapRange(root, start, end, n, cls) {
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let pos = 0, t; const tg = [], out = [];
  while ((t = w.nextNode())) { const L = t.data.length; if (pos + L > start && pos < end) tg.push([t, Math.max(0, start - pos), Math.min(L, end - pos)]); pos += L; if (pos >= end) break; }
  for (const [node, a, b] of tg) {
    if (!node.data.slice(a, b).trim()) continue;
    let x = node; if (a > 0) x = x.splitText(a); if (b - a < x.data.length) x.splitText(b - a);
    const m = document.createElement('mark');
    if (n) { m.dataset.nid = n.id; m.className = (n.style === 'ul' ? 'ul' : n.style === 'st' ? 'st' : '') + (n.note ? ' hasnote' : ''); m.style.setProperty('--hc', n.color); m.style.setProperty('--hcs', solid(n.color)); }
    else m.className = cls || '';
    x.parentNode.insertBefore(m, x); m.appendChild(x); out.push(m);
  }
  return out;
}
function unwrap(marks) { for (const m of marks) { const p = m.parentNode; if (!p) continue; while (m.firstChild) p.insertBefore(m.firstChild, m); p.removeChild(m); p.normalize(); } }
function flashRange(s, e) { const ms = wrapRange(ct(), s, e, null, 'flash'); setTimeout(() => unwrap(ms), 2600); }
function flashNote(n) { const m = $(`mark[data-nid="${n.id}"]`); if (m) { if (!R.paged) pg().scrollTop += m.getBoundingClientRect().top - pg().getBoundingClientRect().top - pg().clientHeight / 3; m.animate([{ opacity: .2 }, { opacity: 1 }], { duration: 400, iterations: 3 }); } }

const COLORS = ['rgba(255,214,0,.42)', 'rgba(110,200,90,.42)', 'rgba(80,160,255,.42)', 'rgba(255,120,160,.42)', 'rgba(255,160,40,.42)'];
let selInfo = null;
document.addEventListener('selectionchange', () => {
  if ($('#rd').classList.contains('hidden') || R.pdf) return;
  const s = window.getSelection(); const c = ct();
  if (!s || s.isCollapsed || !s.rangeCount || !c.contains(s.anchorNode)) { setTimeout(() => { const s2 = window.getSelection(); if (!s2 || s2.isCollapsed) hideSel(); }, 200); return; }
  const r = s.getRangeAt(0); const start = offsetOf(c, r.startContainer, r.startOffset), end = offsetOf(c, r.endContainer, r.endOffset);
  if (end <= start) return;
  selInfo = { start, end, text: r.toString() };
  const sb = $('#selbar'); sb.innerHTML = COLORS.map(col => `<button class="dot" data-c="${col}" style="background:${solid(col)}"></button>`).join('') + `<button class="btn" data-c="ul" style="padding:5px 9px">底線</button><button class="btn" data-c="note" style="padding:5px 9px">筆記</button><button class="btn" data-c="copy" style="padding:5px 9px">複製</button>`;
  sb.classList.remove('hidden');
});
function hideSel() { $('#selbar').classList.add('hidden'); selInfo = null; }
$('#selbar').addEventListener('click', async e => {
  const b = e.target.closest('[data-c]'); if (!b || !selInfo) return;
  const info = selInfo, k = b.dataset.c;
  if (k === 'copy') { navigator.clipboard.writeText(info.text).then(() => toast('已複製'), () => toast('無法複製')); window.getSelection().removeAllRanges(); hideSel(); return; }
  let note = '', color = COLORS[0], style = 'hl';
  if (k === 'note') { note = await askText('筆記', '', true); if (note === null) return; }
  else if (k === 'ul') { style = 'ul'; color = 'rgba(229,160,0,.9)'; }
  else color = k;
  const n = { id: uid(), bookId: R.book.id, chapter: R.chapter, start: info.start, end: info.end, text: info.text, note, color, style, type: 'hl', time: Date.now() };
  await dbPut('notes', n); R.notes.push(n); window.getSelection().removeAllRanges(); hideSel(); await rerender();
});
async function noteMenu(id) {
  const n = R.notes.find(x => x.id === id); if (!n) return; R.menuNote = id;
  const r = await modal('畫線', `<div class="li" style="border:0"><div class="q" style="--c:${solid(n.color)}">${esc(n.text)}</div>${n.note ? `<div class="n">${esc(n.note)}</div>` : ''}</div><div class="seg" style="justify-content:flex-start">${COLORS.map(c => `<button class="dot" data-col="${c}" style="background:${solid(c)}"></button>`).join('')}</div>`, [['刪除', 'del', 'warn'], ['複製', 'copy'], ['編輯筆記', 'edit'], ['關閉', null, 'pri']]);
  if (r === 'del') { await dbDel('notes', id); R.notes = R.notes.filter(x => x.id !== id); }
  if (r === 'copy') navigator.clipboard.writeText(n.text + (n.note ? '\n' + n.note : '')).then(() => toast('已複製'));
  if (r === 'edit') { const v = await askText('筆記', n.note, true); if (v !== null) { n.note = v; await dbPut('notes', n); } }
  if (r === 'del' || r === 'edit' || R.recolored) { R.recolored = false; await rerender(); }
}
$('#mbox').addEventListener('click', async e => { const d = e.target.closest('[data-col]'); if (!d) return; const n = R.notes.find(x => x.id === R.menuNote); if (n) { n.color = d.dataset.col; n.style = 'hl'; await dbPut('notes', n); $('#mbox .q').style.setProperty('--c', solid(n.color)); R.recolored = true; } });
$('#bMark').onclick = async () => {
  const off = R.pdf ? 0 : currentOffset();
  const n = R.pdf ? { chapter: (R.pdfPage || 1) - 1, start: 0, end: 0, text: `第 ${R.pdfPage || 1} 頁` } : { chapter: R.chapter, start: off, end: off, text: ct().textContent.slice(off, off + 40) };
  const rec = { id: uid(), bookId: R.book.id, ...n, note: '', color: 'rgba(120,120,120,.4)', style: 'hl', type: 'bm', time: Date.now() };
  await dbPut('notes', rec); R.notes.push(rec); toast('已加入書籤');
};

/* ---------- panels ---------- */
$('#bToc').onclick = () => {
  showBars(false);
  if (R.pdf) { openSheet(`<h3><span>跳至頁</span></h3><input id="pgIn" type="number" min="1" max="${R.pdf.numPages}" value="${R.pdfPage || 1}" style="font-size:18px;width:120px;padding:6px"> <button class="btn pri" id="pgGo">前往</button>`); $('#pgGo').onclick = () => { closeSheet(); pdfJump(+$('#pgIn').value || 1); }; return; }
  const toc = R.src.toc.length ? R.src.toc : Array.from({ length: R.src.count }, (_, i) => ({ label: R.src.title(i), chapter: i, depth: 0 }));
  let curK = -1; toc.forEach((t, k) => { if (t.chapter <= R.chapter) curK = k; });
  const tot = R.counts ? R.counts.reduce((a, b) => a + b, 0) : 0; const pctAt = ch => tot ? (R.counts.slice(0, ch).reduce((a, b) => a + b, 0) / tot * 100).toFixed(0) + '%' : '';
  openSheet(`<h3><span>目錄</span><span style="flex:none;font-size:12px;color:var(--sub);font-weight:400">${toc.length} 項</span></h3>` + toc.map((t, k) => `<button class="li${k === curK ? ' cur' : ''}" data-k="${k}" style="padding-left:${4 + (t.depth || 0) * 16}px;display:flex;justify-content:space-between;gap:8px"><span>${esc(t.label || '（無標題）')}</span><span style="color:var(--sub);font-size:12px;font-weight:400">${pctAt(t.chapter)}</span></button>`).join(''));
  $('#sheet').onclick = e => { const b = e.target.closest('[data-k]'); if (!b) return; const t = toc[+b.dataset.k]; closeSheet(); showChapter(t.chapter, { frag: t.frag }); };
  const cur = $('#sheet .cur'); if (cur) cur.scrollIntoView({ block: 'center' });
};
$('#bNotes').onclick = () => {
  showBars(false);
  const list = R.notes.slice().sort((a, b) => a.chapter - b.chapter || a.start - b.start);
  const label = n => R.pdf ? `第 ${n.chapter + 1} 頁` : (R.src ? R.src.title(n.chapter) : '');
  const tab = R.notesTab || 'hl';
  const shown = list.filter(n => tab === 'bm' ? n.type === 'bm' : n.type !== 'bm');
  openSheet(`<h3><span>筆記</span><button class="btn" data-a="exp" style="font-size:13px">匯出</button></h3>
    <div class="seg" style="justify-content:flex-start;margin-bottom:6px"><button data-t="hl" class="${tab === 'hl' ? 'on' : ''}">畫線與筆記 ${list.filter(n => n.type !== 'bm').length}</button><button data-t="bm" class="${tab === 'bm' ? 'on' : ''}">書籤 ${list.filter(n => n.type === 'bm').length}</button></div>` +
    (shown.map(n => `<button class="li" data-id="${n.id}"><div class="q" style="--c:${solid(n.color)}">${esc((n.text || '').slice(0, 200)) || '（無文字）'}</div>${n.note ? `<div class="n">${esc(n.note)}</div>` : ''}<div class="m">${esc(label(n))}${n.lost ? '・原文位置未對上' : ''}${n.time ? '・' + new Date(n.time).toLocaleDateString('zh-TW') : ''}</div></button>`).join('') || '<div class="empty" style="padding:24px">尚無</div>'));
  $('#sheet').onclick = async e => {
    const t = e.target.closest('[data-t]'); if (t) { R.notesTab = t.dataset.t; $('#bNotes').onclick(); return; }
    if (e.target.closest('[data-a="exp"]')) { exportNotes(R.book, R.notes); return; }
    const b = e.target.closest('[data-id]'); if (!b) return; const n = R.notes.find(x => x.id === b.dataset.id); closeSheet();
    if (R.pdf) { pdfJump(n.chapter + 1); return; }
    if (n.chapter !== R.chapter) await showChapter(n.chapter, { offset: n.start, mark: n });
    else { scrollToOffset(n.start); flashNote(n); }
  };
};
$('#bNight').onclick = () => { R.settings.night = !R.settings.night; applySettings(); saveSettings(); };
$('#bSet').onclick = () => settingsSheet();
async function settingsSheet(again) {
  showBars(false); if (!again && !R.pdf) R.anchor = currentOffset();
  const s = R.settings; const fonts = await loadFonts();
  const seg = (k, opts) => `<div class="seg">${opts.map(([v, l]) => `<button data-k="${k}" data-v="${v}" class="${String(s[k]) === String(v) ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  openSheet(`<h3><span>閱讀設定</span></h3>
  <div class="set"><span>字級</span><div class="seg"><button data-act="fs-">A−</button><span style="min-width:34px;text-align:center;align-self:center">${s.fs}</span><button data-act="fs+">A＋</button></div></div>
  <div class="set"><span>背景</span><div class="seg">${THEMES.map(([v, c, l]) => `<button class="sw${(s.night ? s.nightRt : s.rt) === v ? ' on' : ''}" data-theme="${v}" title="${l}" style="background:${c}"></button>`).join('')}</div></div>
  <div class="set"><span>亮度</span><input type="range" id="brIn" min="25" max="100" value="${Math.round(s.bright * 100)}" style="flex:1;accent-color:var(--acc)"></div>
  <div class="set"><span>字體</span>${seg('ff', [...FONTS.map(f => [f[0], f[1]]), ...fonts.map(f => [f.id, f.name])])}</div>
  <div class="set"><span>翻頁</span>${seg('mode', [['page', '左右翻頁'], ['scroll', '上下捲動']])}</div>
  <div class="set"><span>行距</span>${seg('lh', [[1.5, '密'], [1.8, '中'], [2.1, '鬆'], [2.4, '寬鬆']])}</div>
  <div class="set"><span>段距</span>${seg('ps', [[0, '無'], [0.5, '小'], [1, '大']])}</div>
  <div class="set"><span>邊距</span>${seg('mg', [[12, '窄'], [22, '中'], [34, '寬']])}</div>
  <div class="set"><span>首行縮排</span>${seg('indent', [['true', '開'], ['false', '關']])}</div>
  <div class="set"><span>對齊</span>${seg('ta', [['justify', '兩端'], ['left', '靠左']])}</div>
  <div class="set"><span>繁簡</span>${seg('conv', [['none', '不轉換'], ['s2t', '簡→繁'], ['t2s', '繁→簡']])}</div>
  <div class="set"><span>點兩側</span>${seg('tap', [['lr', '左上頁／右下頁'], ['next', '都翻下頁']])}</div>
  <div class="set"><span>翻頁動畫</span>${seg('anim', [['true', '開'], ['false', '關']])}</div>
  <div class="set"><span>螢幕常亮</span>${seg('awake', [['true', '開'], ['false', '關']])}</div>
  <div class="set" style="border:0"><span></span><button class="btn" data-act="guide">操作說明</button></div>`);
  $('#brIn').oninput = e => { s.bright = e.target.value / 100; applySettings(); };
  $('#brIn').onchange = () => saveSettings();
  $('#sheet').onclick = async e => {
    const b = e.target.closest('button'); if (!b) return;
    const off = R.pdf ? 0 : (R.anchor ?? currentOffset()); let relay = true;
    if (b.dataset.act === 'fs-') s.fs = Math.max(12, s.fs - 1);
    else if (b.dataset.act === 'fs+') s.fs = Math.min(34, s.fs + 1);
    else if (b.dataset.act === 'guide') { closeSheet(); $('#guide').classList.remove('hidden'); return; }
    else if (b.dataset.theme) { if (s.night) s.nightRt = b.dataset.theme; else s.rt = b.dataset.theme; relay = false; }
    else if (b.dataset.k) { const v = b.dataset.v; s[b.dataset.k] = v === 'true' ? true : v === 'false' ? false : isNaN(+v) ? v : +v; if (['tap', 'anim'].includes(b.dataset.k)) relay = false; if (b.dataset.k === 'awake') { s.awake ? wakeOn() : wakeOff(); relay = false; } }
    else return;
    applySettings(); await saveSettings();
    if (b.dataset.k === 'conv' && R.src) { R.conv = await converter(s.conv).catch(() => null); await showChapter(R.chapter, { offset: off }); }
    else if (b.dataset.k === 'mode' && R.src) await showChapter(R.chapter, { offset: off });
    else if (relay && R.src) { await sleep(30); R.lastOff = off; await relayout(); }
    const top = $('#sheet').scrollTop; await settingsSheet(true); $('#sheet').scrollTop = top;
  };
}
$('#bFind').onclick = () => {
  showBars(false);
  if (R.pdf) return toast('PDF 暫不支援書內搜尋');
  openSheet(`<h3><span>書內搜尋</span></h3><div style="display:flex;gap:8px"><input id="fq" type="search" placeholder="輸入關鍵字" value="${esc(R.lastQ || '')}" style="flex:1;padding:8px 10px;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--fg);font-size:16px"><button class="btn pri" id="fgo">搜尋</button></div><div id="fres" style="margin-top:6px"></div>`);
  const run = async () => {
    const q = $('#fq').value.trim(); R.lastQ = q; if (!q) return;
    const box = $('#fres'); box.innerHTML = '<div style="color:var(--sub);padding:10px">搜尋中…</div>';
    const res = []; const ql = q.toLowerCase();
    for (let i = 0; i < R.src.count && res.length < 500; i++) {
      let t = await R.src.text(i); if (R.conv) t = R.conv(t); const tl = t.toLowerCase(); let at = tl.indexOf(ql);
      while (at >= 0 && res.length < 500) { res.push({ ch: i, at, ctx: t.slice(Math.max(0, at - 18), at + q.length + 30), k: Math.min(18, at) }); at = tl.indexOf(ql, at + q.length); }
    }
    R.found = res;
    box.innerHTML = `<div style="color:var(--sub);font-size:12px;padding:6px 2px">${res.length >= 500 ? '超過 500 筆，只列前 500 筆' : `共 ${res.length} 筆`}</div>` + res.map((r, k) => `<button class="li" data-k="${k}"><div>${esc(r.ctx.slice(0, r.k))}<em>${esc(r.ctx.slice(r.k, r.k + q.length))}</em>${esc(r.ctx.slice(r.k + q.length))}</div><div class="m" style="padding:0">${esc(R.src.title(r.ch))}</div></button>`).join('');
  };
  $('#fgo').onclick = run; $('#fq').onkeydown = e => { if (e.key === 'Enter') run(); };
  $('#sheet').onclick = async e => { const b = e.target.closest('[data-k]'); if (!b) return; const r = R.found[+b.dataset.k]; closeSheet(); await showChapter(r.ch, { flash: { start: r.at, end: r.at + R.lastQ.length } }); };
  setTimeout(() => $('#fq')?.focus(), 100);
};
$('#bMore').onclick = () => {
  showBars(false);
  const b = R.book;
  openSheet(`<h3><span>${esc(b.title)}</span></h3>
    <button class="li" data-a="auto">⏵ 自動${R.paged ? '翻頁' : '捲動'}</button>
    <button class="li" data-a="tts">🔊 朗讀（TTS）</button>
    <button class="li" data-a="jump">↦ 跳到百分比</button>
    <button class="li" data-a="exp">📝 匯出筆記</button>
    <button class="li" data-a="info">ⓘ 書籍資訊</button>
    <div style="color:var(--sub);font-size:12px;margin-top:10px">本書閱讀 ${fmtDur(b.readMs || 0)}・${R.src ? `共 ${R.src.count} 章` : R.pdf ? `共 ${R.pdf.numPages} 頁` : ''}</div>`);
  $('#sheet').onclick = async e => {
    const a = e.target.closest('[data-a]')?.dataset.a; if (!a) return;
    if (a === 'auto') { closeSheet(); autoStart(); }
    if (a === 'tts') { closeSheet(); ttsStart(); }
    if (a === 'jump') { const v = await askText('跳到百分比（0–100）', bookPct().toFixed(1)); if (v === null) return; const p = Math.max(0, Math.min(100, parseFloat(v) || 0)); closeSheet(); if (R.pdf) pdfJump(Math.max(1, Math.round(p / 100 * R.pdf.numPages))); else if (R.counts) { const t = globalToLocal(R.counts, p / 100 * R.counts.reduce((x, y) => x + y, 0)); await showChapter(t.chapter, { offset: t.offset }); } }
    if (a === 'exp') exportNotes(b, R.notes);
    if (a === 'info') { const nb = await dbGet('books', b.id); modal(nb.title, `${esc(nb.author || '未知作者')}<br>${nb.fmt.toUpperCase()}・${(nb.size / 1048576).toFixed(1)} MB<br>進度 ${(nb.pct || 0).toFixed(1)}%<br>閱讀時間 ${fmtDur(nb.readMs || 0)}<br>加入 ${new Date(nb.added).toLocaleDateString('zh-TW')}<br>檔名 ${esc(nb.name)}`); }
  };
};

/* ---------- PDF ---------- */
async function openPdf(book) {
  const pdfjs = await loadPdfjs();
  R.src = null;
  R.pdf = await pdfjs.getDocument({ data: new Uint8Array(await book.blob.arrayBuffer()) }).promise; layout();
  const pr = await dbGet('progress', book.id);
  let pnum = pr ? pr.chapter + 1 : 1;
  if (!pr && book.moonPos) { const p = book.moonPos; pnum = p.chapter > 0 && p.chapter < R.pdf.numPages ? p.chapter + 1 : Math.max(1, Math.round(p.pct / 100 * R.pdf.numPages)); }
  for (const n of R.notes.filter(n => n.unresolved)) { n.chapter = Math.min(Math.max(0, n.raw.chapter), R.pdf.numPages - 1); n.unresolved = false; await dbPut('notes', n); }
  const c = ct(); c.innerHTML = ''; $('#chend').innerHTML = ''; $('#hdr').textContent = book.title;
  const first = await R.pdf.getPage(1); const vp = first.getViewport({ scale: 1 });
  const W = Math.min(c.clientWidth || window.innerWidth - 40, 900); R.pdfScale = W / vp.width;
  for (let i = 1; i <= R.pdf.numPages; i++) { const d = document.createElement('div'); d.className = 'pdfp'; d.dataset.p = i; d.style.width = W + 'px'; d.style.height = vp.height * R.pdfScale + 'px'; d.innerHTML = `<span class="pn">${i}</span>`; c.appendChild(d); }
  const io = new IntersectionObserver(es => es.forEach(en => { if (en.isIntersecting) renderPdfPage(en.target); }), { root: pg(), rootMargin: '600px 0px' });
  c.querySelectorAll('.pdfp').forEach(d => io.observe(d));
  await raf(); pdfJump(pnum);
  pg().addEventListener('scroll', pdfTrack, { passive: true });
}
async function renderPdfPage(d) {
  if (d.dataset.done || !R.pdf) return; d.dataset.done = 1;
  const p = await R.pdf.getPage(+d.dataset.p); const dpr = Math.min(2, window.devicePixelRatio || 1);
  const vp = p.getViewport({ scale: R.pdfScale * dpr }); const cv = document.createElement('canvas'); cv.width = vp.width; cv.height = vp.height;
  d.prepend(cv); await p.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
}
function pdfTrack() { if (!R.pdf) return; const y = pg().getBoundingClientRect().top + pg().clientHeight / 3; for (const d of ct().children) { const r = d.getBoundingClientRect(); if (r.bottom > y) { R.pdfPage = +d.dataset.p; break; } } updateFooter(); saveProgress(); }
function pdfJump(p) { const d = $(`.pdfp[data-p="${p}"]`); if (d) { pg().scrollTop += d.getBoundingClientRect().top - pg().getBoundingClientRect().top - 20; R.pdfPage = p; updateFooter(); saveProgress(); } }
