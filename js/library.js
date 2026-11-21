'use strict';
/* 月讀 library (書架) */
const L = { tab: 'recent', group: null, sort: 'recent', view: 'grid', filter: 'all', q: '', selecting: false, sel: new Set() };
const TABS = [['recent', '最近閱讀'], ['all', '全部'], ['fav', '收藏'], ['tags', '書架'], ['author', '作者'], ['folder', '資料夾']];
const SORTS = [['recent', '最近閱讀'], ['added', '加入時間'], ['title', '書名'], ['author', '作者'], ['progress', '進度'], ['size', '檔案大小']];
const FILTERS = [['all', '全部'], ['unread', '未讀'], ['reading', '閱讀中'], ['done', '已讀完']];
const coverCache = new Map();
function coverURL(b) {
  if (!b.cover) return '';
  const c = coverCache.get(b.id); const v = (b.coverV || 0) + ':' + b.cover.size;
  if (c && c.v === v) return c.url; if (c) URL.revokeObjectURL(c.url);
  const url = URL.createObjectURL(b.cover); coverCache.set(b.id, { v, url }); return url;
}
const isDone = b => b.finished || (b.pct || 0) >= 99.5;
const status = b => isDone(b) ? 'done' : (b.lastRead || b.pct > 0) ? 'reading' : 'unread';
function coverHTML(b, small) {
  const u = coverURL(b); const h = hue(b.title + b.author);
  return `<div class="cv" style="background:linear-gradient(160deg,hsl(${h},32%,46%),hsl(${(h + 30) % 360},38%,30%))">${u ? `<img src="${u}" alt="" loading="lazy">` : `<div class="ph"><b>${esc(b.title)}</b><i>${esc(b.author || '')}</i></div>`}${small ? '' : `<span class="fmt">${b.fmt.toUpperCase()}</span>`}${b.favorite ? '<span class="fav">★</span>' : ''}${isDone(b) ? '<span class="done">讀完</span>' : (b.pct > 0 ? `<div class="pb"><i style="width:${Math.min(100, b.pct)}%"></i></div>` : '')}</div>`;
}
function cardHTML(b) {
  const sel = L.selecting ? `<span class="ck">${L.sel.has(b.id) ? '✓' : ''}</span>` : '';
  if (L.view === 'list') return `<button class="bk${L.sel.has(b.id) ? ' sel' : ''}" data-id="${b.id}">${sel}${coverHTML(b, true)}<div class="meta"><div class="bt">${esc(b.title)}</div><div class="bs">${esc(b.author || '　')}</div><div class="bs">${isDone(b) ? '已讀完' : b.pct > 0 ? b.pct.toFixed(1) + '%' : '未讀'}${b.lastRead ? '・' + relTime(b.lastRead) : ''}${b.readMs ? '・讀了 ' + fmtDur(b.readMs) : ''}</div><div class="lp"><i style="width:${Math.min(100, b.pct || 0)}%"></i></div></div></button>`;
  return `<button class="bk${L.sel.has(b.id) ? ' sel' : ''}" data-id="${b.id}">${sel}${coverHTML(b)}<div class="bt">${esc(b.title)}</div><div class="bs">${b.lastRead ? relTime(b.lastRead) : esc(b.author || '')}</div></button>`;
}
const wrapBooks = arr => `<div class="${L.view === 'list' ? 'list' : 'grid'}">${arr.map(cardHTML).join('')}</div>`;
function sortBooks(arr, how) {
  const cmp = {
    recent: (a, b) => (b.lastRead || 0) - (a.lastRead || 0) || b.added - a.added,
    added: (a, b) => b.added - a.added,
    title: (a, b) => a.title.localeCompare(b.title, 'zh-Hant-TW-u-co-stroke'),
    author: (a, b) => (a.author || '￿').localeCompare(b.author || '￿', 'zh-Hant') || a.title.localeCompare(b.title, 'zh-Hant'),
    progress: (a, b) => (b.pct || 0) - (a.pct || 0),
    size: (a, b) => b.size - a.size
  }[how];
  return arr.sort(cmp);
}
function groupsOf(books, tab) {
  const m = new Map(); const add = (k, b) => { if (!m.has(k)) m.set(k, []); m.get(k).push(b); };
  for (const b of books) {
    if (tab === 'tags') { (b.shelves || []).forEach(s => add(s, b)); if (!(b.shelves || []).length) add('（未分類）', b); }
    if (tab === 'author') add(b.author || '（未知作者）', b);
    if (tab === 'folder') add(b.folder || '（根目錄）', b);
  }
  return [...m.entries()].map(([name, arr]) => ({ name, books: sortBooks(arr, 'recent') })).sort((a, b) => (/^（/.test(a.name) - /^（/.test(b.name)) || ((b.books[0].lastRead || 0) - (a.books[0].lastRead || 0)) || a.name.localeCompare(b.name, 'zh-Hant'));
}
async function renderLib() {
  let books = await dbAll('books');
  const q = L.q.trim().toLowerCase();
  if (q) books = books.filter(b => (b.title + ' ' + (b.author || '') + ' ' + b.name + ' ' + (b.shelves || []).join(' ')).toLowerCase().includes(q));
  $('#tabs').innerHTML = TABS.map(([k, l]) => `<button class="tab${k === L.tab ? ' on' : ''}" data-t="${k}">${l}</button>`).join('');
  $('#lback').classList.toggle('hidden', !L.group);
  $('#ltitle').textContent = L.group || '書架';
  $('#tabs').classList.toggle('hidden', !!L.group);
  $('#selbarL').classList.toggle('hidden', !L.selecting); $('#fab').classList.toggle('hidden', L.selecting);
  $('#selN').textContent = `已選 ${L.sel.size} 本`;
  const body = $('#lbody'); let h = '';
  const pend = (await dbAll('pending')).filter(r => !r.applied && (r.notes?.length || r.pos)).length;
  if (pend && !L.group) h += `<div class="notice">靜讀天下還有 ${pend} 本書的進度／畫線在等書檔，匯入同名書檔後會自動套用。</div>`;
  const all = await dbAll('books');
  if (!all.length) {
    body.innerHTML = `<div class="empty">還沒有書。<br>按右下角「＋」匯入：<br>靜讀天下備份檔（.mrpro）<br>書檔（EPUB／PDF／TXT，可多選）<br>或在「⋯」選「WiFi 傳書」從電腦傳</div>`; return;
  }
  const filt = arr => L.filter === 'all' ? arr : arr.filter(b => status(b) === L.filter);
  if (L.group) {
    const g = groupsOf(books, L.tab).find(x => x.name === L.group);
    h += g ? wrapBooks(sortBooks(filt(g.books), L.sort)) : '<div class="empty">此分類沒有書</div>';
  } else if (L.tab === 'recent') {
    const now = new Date(); const t0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime(), day = 864e5;
    const buckets = [['今天', t0], ['昨天', t0 - day], ['本週', t0 - 6 * day], ['本月', t0 - 29 * day], ['更早', 1]];
    const read = sortBooks(books.filter(b => b.lastRead), 'recent'); const unread = sortBooks(books.filter(b => !b.lastRead), 'added');
    for (let i = 0; i < buckets.length; i++) {
      const [label, from] = buckets[i]; const to = i ? buckets[i - 1][1] : Infinity;
      const arr = read.filter(b => b.lastRead >= from && b.lastRead < to); if (arr.length) h += `<div class="sec">${label}・${arr.length}</div>` + wrapBooks(arr);
    }
    if (unread.length) h += `<div class="sec">尚未開始・${unread.length}</div>` + wrapBooks(unread);
  } else if (L.tab === 'all' || L.tab === 'fav') {
    let arr = L.tab === 'fav' ? books.filter(b => b.favorite) : books; arr = sortBooks(filt(arr), L.sort);
    if (L.tab === 'all' && L.sort === 'recent' && L.filter === 'all') {
      for (const [k, label] of [['reading', '閱讀中'], ['unread', '未讀'], ['done', '已讀完']]) { const a = arr.filter(b => status(b) === k); if (a.length) h += `<div class="sec">${label}・${a.length}</div>` + wrapBooks(a); }
    } else h += arr.length ? `<div class="sec">${FILTERS.find(f => f[0] === L.filter)[1]}・${arr.length} 本・依${SORTS.find(s => s[0] === L.sort)[1]}</div>` + wrapBooks(arr) : `<div class="empty">${L.tab === 'fav' ? '還沒有收藏。長按書本可加入收藏。' : '沒有符合的書'}</div>`;
  } else {
    const gs = groupsOf(books, L.tab);
    h += gs.length ? `<div class="groups">${gs.map(g => `<button class="grp" data-g="${esc(g.name)}"><div class="col">${[0, 1, 2, 3].map(i => { const b = g.books[i]; const u = b && coverURL(b); return `<div style="${b && !u ? `background:hsl(${hue(b.title)},30%,45%)` : ''}">${u ? `<img src="${u}" alt="">` : ''}</div>`; }).join('')}</div><b>${esc(g.name)}</b><span>${g.books.length} 本</span></button>`).join('')}</div>` : '<div class="empty">沒有分類</div>';
    if (L.tab === 'tags') h += `<div style="margin-top:16px;color:var(--sub);font-size:12px;text-align:center">長按書本 →「書架」可加入或新增書架</div>`;
  }
  body.innerHTML = h;
}
window.renderLib = renderLib;
async function persistUI() { await metaSet('libui', { tab: L.tab, sort: L.sort, view: L.view, filter: L.filter }); }

$('#tabs').onclick = e => { const t = e.target.closest('.tab'); if (!t) return; L.tab = t.dataset.t; $('#lbody').scrollTop = 0; persistUI(); renderLib(); };
$('#lback').onclick = () => backLayer('group');
$('#search').oninput = e => { L.q = e.target.value; renderLib(); };
$('#bSearchL').onclick = () => { const s = $('#lsearch'); s.classList.toggle('hidden'); if (!s.classList.contains('hidden')) $('#search').focus(); else { L.q = ''; $('#search').value = ''; renderLib(); } };
$('#fab').onclick = async () => { const f = await pickFile('#fileIn', { accept: '' }); if (f.length) handleFiles(f); };

let pressT = null, pressed = false, pressXY = null;
const lb = $('#lbody');
lb.addEventListener('touchstart', e => { const b = e.target.closest('.bk'); if (!b || L.selecting) return; pressed = false; pressXY = [e.touches[0].clientX, e.touches[0].clientY]; pressT = setTimeout(() => { pressed = true; navigator.vibrate?.(10); bookSheet(b.dataset.id); }, 480); }, { passive: true });
lb.addEventListener('touchmove', e => { if (pressXY && Math.hypot(e.touches[0].clientX - pressXY[0], e.touches[0].clientY - pressXY[1]) > 10) clearTimeout(pressT); }, { passive: true });
['touchend', 'touchcancel'].forEach(ev => lb.addEventListener(ev, () => clearTimeout(pressT), { passive: true }));
lb.addEventListener('contextmenu', e => { const b = e.target.closest('.bk'); if (b) { e.preventDefault(); if (!pressed) bookSheet(b.dataset.id); pressed = true; } });
lb.onclick = e => {
  const g = e.target.closest('.grp'); if (g) { L.group = g.dataset.g; pushLayer('group', () => { L.group = null; renderLib(); }); $('#lbody').scrollTop = 0; renderLib(); return; }
  const b = e.target.closest('.bk'); if (!b) return;
  if (pressed) { pressed = false; return; }
  if (L.selecting) { L.sel.has(b.dataset.id) ? L.sel.delete(b.dataset.id) : L.sel.add(b.dataset.id); renderLib(); return; }
  openBook(b.dataset.id);
};

/* sort / view / filter sheet */
function openSheet(html, name = 'panel') {
  $('#sheet').innerHTML = html; $('#panel').classList.remove('hidden');
  if (topLayer() !== 'panel') pushLayer('panel', () => $('#panel').classList.add('hidden'));
}
const closeSheet = () => backLayer('panel');
$('#panel').addEventListener('click', e => { if (e.target.id === 'panel') closeSheet(); });
$('#bSort').onclick = () => {
  const seg = (k, opts) => `<div class="seg">${opts.map(([v, l]) => `<button data-k="${k}" data-v="${v}" class="${L[k] === v ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  openSheet(`<h3><span>排序與檢視</span></h3>
    <div class="set"><span>排序</span>${seg('sort', SORTS)}</div>
    <div class="set"><span>篩選</span>${seg('filter', FILTERS)}</div>
    <div class="set"><span>檢視</span>${seg('view', [['grid', '封面'], ['list', '清單']])}</div>`);
  $('#sheet').onclick = e => { const b = e.target.closest('[data-k]'); if (!b) return; L[b.dataset.k] = b.dataset.v; if (b.dataset.k === 'sort' && L.tab === 'recent') L.tab = 'all'; persistUI(); renderLib(); $('#sheet').querySelectorAll(`[data-k="${b.dataset.k}"]`).forEach(x => x.classList.toggle('on', x === b)); };
};

/* selection mode */
$('#bSelect').onclick = () => { L.selecting = !L.selecting; L.sel.clear(); renderLib(); };
$('#selbarL').onclick = async e => {
  const a = e.target.closest('[data-a]')?.dataset.a; if (!a) return;
  const ids = [...L.sel];
  if (a === 'done') { L.selecting = false; L.sel.clear(); return renderLib(); }
  if (!ids.length) return toast('先點選書本');
  if (a === 'fav') { const books = await Promise.all(ids.map(id => dbGet('books', id))); const to = !books.every(b => b.favorite); for (const id of ids) await updBook(id, { favorite: to }); toast(to ? '已加入收藏' : '已取消收藏'); }
  if (a === 'tag') { await tagSheet(ids); return; }
  if (a === 'del') { if (!(await confirmBox(`刪除 ${ids.length} 本書？`, '書檔、進度與畫線都會刪除。', '刪除', 'warn'))) return; for (const id of ids) await deleteBook(id); L.sel.clear(); }
  renderLib();
};
async function deleteBook(id) {
  for (const n of await notesOf(id)) await dbDel('notes', n.id);
  await dbDel('progress', id); await dbDel('books', id);
  for (const p of await dbAll('pending')) if (p.bookId === id) { p.applied = false; delete p.bookId; await dbPut('pending', p); }
}

/* tags (書架) */
async function tagSheet(ids) {
  const books = await Promise.all(ids.map(id => dbGet('books', id)));
  const all = new Set(); (await dbAll('books')).forEach(b => (b.shelves || []).forEach(s => all.add(s)));
  const on = s => books.every(b => (b.shelves || []).includes(s));
  const draw = () => {
    openSheet(`<h3><span>書架${ids.length > 1 ? `（${ids.length} 本）` : ''}</span><button class="btn pri" data-a="ok">完成</button></h3>
      <div class="chips">${[...all].sort((a, b) => a.localeCompare(b, 'zh-Hant')).map(s => `<button class="chip${on(s) ? ' on' : ''}" data-s="${esc(s)}">${esc(s)}</button>`).join('') || '<span style="color:var(--sub)">還沒有書架</span>'}</div>
      <button class="btn" data-a="new" style="margin-top:6px">＋ 新增書架</button>`);
  };
  draw();
  $('#sheet').onclick = async e => {
    const c = e.target.closest('[data-s]');
    if (c) { const s = c.dataset.s, to = !on(s); for (const b of books) { b.shelves = to ? [...new Set([...(b.shelves || []), s])] : (b.shelves || []).filter(x => x !== s); await dbPut('books', b); } c.classList.toggle('on', to); renderLib(); return; }
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'new') { const v = await askText('新書架名稱'); if (v && v.trim()) { all.add(v.trim()); for (const b of books) { b.shelves = [...new Set([...(b.shelves || []), v.trim()])]; await dbPut('books', b); } draw(); renderLib(); } }
    if (a === 'ok') closeSheet();
  };
}

/* book info sheet */
async function bookSheet(id) {
  const b = await dbGet('books', id); if (!b) return;
  const notes = await notesOf(id);
  const hl = notes.filter(n => n.type !== 'bm').length, bm = notes.filter(n => n.type === 'bm').length;
  openSheet(`<div class="binfo">${coverHTML(b)}<div class="meta"><b>${esc(b.title)}</b>${esc(b.author || '未知作者')}<br>${b.fmt.toUpperCase()}・${(b.size / 1048576).toFixed(1)} MB<br>進度 ${isDone(b) ? '已讀完' : (b.pct || 0).toFixed(1) + '%'}${b.lastRead ? '・' + relTime(b.lastRead) : ''}<br>閱讀時間 ${fmtDur(b.readMs || 0)}・畫線 ${hl}・書籤 ${bm}<br>書架：${esc((b.shelves || []).join('、') || '無')}${b.folder ? '<br>資料夾：' + esc(b.folder) : ''}</div></div>
    <button class="btn pri" data-a="open" style="width:100%;margin-bottom:10px;padding:11px">${b.lastRead ? '繼續閱讀' : '開始閱讀'}</button>
    <div class="acts">
      <button data-a="fav"><i>${b.favorite ? '★' : '☆'}</i>${b.favorite ? '取消收藏' : '收藏'}</button>
      <button data-a="tag"><i>🗂</i>書架</button>
      <button data-a="cover"><i>🖼</i>換封面</button>
      <button data-a="edit"><i>✎</i>改書名作者</button>
      <button data-a="done"><i>${isDone(b) ? '↺' : '✓'}</i>${isDone(b) ? '標為未讀完' : '標為讀完'}</button>
      <button data-a="notes"><i>📝</i>匯出筆記</button>
      ${b.coverCustom ? '<button data-a="uncover"><i>⟲</i>還原封面</button>' : ''}
      <button data-a="del" style="color:#d33"><i>🗑</i>刪除</button>
    </div>`);
  $('#sheet').onclick = async e => {
    const a = e.target.closest('[data-a]')?.dataset.a; if (!a) return;
    if (a === 'open') { closeSheet(); setTimeout(() => openBook(id), 150); return; }
    if (a === 'fav') { await updBook(id, { favorite: !b.favorite }); toast(b.favorite ? '已取消收藏' : '已加入收藏'); }
    if (a === 'tag') return tagSheet([id]);
    if (a === 'cover') { const [f] = await pickFile('#coverIn', { accept: 'image/*' }); if (!f) return; await updBook(id, { cover: await shrinkImage(f), coverCustom: true, coverV: Date.now() }); toast('已更換封面'); }
    if (a === 'uncover') { let cover = null; if (b.fmt === 'epub') cover = (await epubMeta(b.blob)).cover; if (b.fmt === 'pdf') cover = await pdfCover(b.blob); const p = (await dbAll('pending')).find(r => r.bookId === id); if (p?.cover) cover = p.cover; await updBook(id, { cover, coverCustom: false, coverV: Date.now() }); }
    if (a === 'edit') { const t = await askText('書名', b.title); if (t === null) return; const au = await askText('作者', b.author || ''); await updBook(id, { title: t.trim() || b.title, author: (au ?? b.author).trim() }); }
    if (a === 'done') await updBook(id, { finished: !isDone(b), pct: isDone(b) ? Math.min(b.pct || 0, 99) : 100 });
    if (a === 'notes') { await exportNotes(b, notes); return; }
    if (a === 'del') { if (!(await confirmBox('刪除這本書？', '書檔、進度與畫線都會刪除。', '刪除', 'warn'))) return; await deleteBook(id); closeSheet(); renderLib(); return; }
    await renderLib(); bookSheet(id);
  };
}
async function shrinkImage(file, max = 600) {
  try {
    const bmp = await createImageBitmap(file); const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height); return await new Promise(r => c.toBlob(r, 'image/jpeg', 0.88));
  } catch (e) { return file; }
}
async function exportNotes(b, notes) {
  const list = notes.filter(n => n.type !== 'bm' && !n.unresolved).sort((x, y) => x.chapter - y.chapter || x.start - y.start);
  if (!list.length) return toast('沒有畫線或筆記');
  const t = `# ${b.title}\n${b.author ? b.author + '\n' : ''}\n` + list.map(n => `> ${n.text}${n.note ? '\n\n' + n.note : ''}`).join('\n\n---\n\n');
  const file = new File([t], `${b.title}-筆記.md`, { type: 'text/markdown' });
  try { if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file] }); return; } } catch (e) { if (e.name === 'AbortError') return; }
  navigator.clipboard.writeText(t).then(() => toast('已複製全部筆記'), () => toast('無法複製'));
}

/* main menu */
$('#bMenu').onclick = async () => {
  const hasPin = !!(await metaGet('pin', null));
  let off = '檢查中'; try { off = navigator.serviceWorker?.controller && (await caches.keys()).some(k => k.startsWith('moonios')) ? '已可離線使用 ✓' : '尚未就緒（連網開一次後即可離線）'; } catch (e) { off = '不支援'; }
  let est = ''; try { const e = await navigator.storage.estimate(); est = `已用 ${(e.usage / 1048576).toFixed(0)} MB`; } catch (x) {}
  openSheet(`<h3><span>月讀</span></h3>
    <button class="li" data-a="import">＋ 匯入書檔／靜讀天下備份</button>
    <button class="li" data-a="xfer">📶 WiFi 傳書（從電腦傳）</button>
    <button class="li" data-a="stats">📊 閱讀統計</button>
    <button class="li" data-a="pin">🔒 ${hasPin ? '密碼設定' : '設定 4 位數密碼'}</button>
    <button class="li" data-a="fonts">🔤 字型管理</button>
    <button class="li" data-a="theme">◐ 介面外觀：${({ auto: '跟隨系統', light: '淺色', dark: '深色' })[R.settings.ui || 'auto']}</button>
    <button class="li" data-a="exp">⇪ 匯出月讀備份（換手機用）</button>
    <button class="li" data-a="wipe" style="color:#d33">清除全部資料</button>
    <div style="color:var(--sub);font-size:12px;margin-top:12px;line-height:1.7">離線：${off}<br>${est}・版本 3</div>`);
  $('#sheet').onclick = async e => {
    const a = e.target.closest('[data-a]')?.dataset.a; if (!a) return;
    if (a === 'import') { closeSheet(); const f = await pickFile('#fileIn', { accept: '' }); if (f.length) handleFiles(f); }
    if (a === 'xfer') { closeSheet(); setTimeout(openTransfer, 80); }
    if (a === 'stats') statsSheet();
    if (a === 'pin') { closeSheet(); setTimeout(() => pinMenu(hasPin), 80); }
    if (a === 'fonts') fontSheet();
    if (a === 'theme') { const order = ['auto', 'light', 'dark']; R.settings.ui = order[(order.indexOf(R.settings.ui || 'auto') + 1) % 3]; await saveSettings(); applyUITheme(); $('#bMenu').onclick(); }
    if (a === 'exp') exportAppBackup();
    if (a === 'wipe' && await confirmBox('清除全部資料？', '書檔、進度、畫線全部刪除，無法復原。', '全部清除', 'warn')) { _db && _db.close(); _db = null; indexedDB.deleteDatabase('moonios'); setTimeout(() => location.reload(), 300); }
  };
};
async function statsSheet() {
  const daily = await metaGet('daily', {}); const books = await dbAll('books');
  const today = daily[dayKey()] || 0; let week = 0; for (let i = 0; i < 7; i++) week += daily[dayKey(Date.now() - i * 864e5)] || 0;
  const total = books.reduce((a, b) => a + (b.readMs || 0), 0);
  const days = Array.from({ length: 14 }, (_, i) => { const k = dayKey(Date.now() - (13 - i) * 864e5); return [k.slice(5), daily[k] || 0]; });
  const mx = Math.max(1, ...days.map(d => d[1]));
  const top = books.filter(b => b.readMs >= 60000).sort((a, b) => b.readMs - a.readMs).slice(0, 10);
  openSheet(`<h3><span>閱讀統計</span></h3>
    <div class="stat"><div><b>${fmtDur(today)}</b><span>今天</span></div><div><b>${fmtDur(week)}</b><span>近 7 天</span></div><div><b>${fmtDur(total)}</b><span>累計</span></div></div>
    <div class="stat"><div><b>${books.filter(isDone).length}</b><span>讀完</span></div><div><b>${books.filter(b => status(b) === 'reading').length}</b><span>閱讀中</span></div><div><b>${books.length}</b><span>藏書</span></div></div>
    <div style="display:flex;align-items:flex-end;gap:3px;height:90px;margin:6px 0 2px">${days.map(([d, v]) => `<div style="flex:1;display:flex;flex-direction:column;justify-content:flex-end;height:100%"><div style="height:${Math.max(2, v / mx * 100)}%;background:var(--acc);border-radius:3px 3px 0 0;opacity:${v ? 1 : .25}"></div></div>`).join('')}</div>
    <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--sub)"><span>${days[0][0]}</span><span>近 14 天</span><span>${days[13][0]}</span></div>
    ${top.length ? `<div class="sec">讀最久的書</div>${top.map(b => `<div class="li" style="display:flex;justify-content:space-between"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(b.title)}</span><span style="color:var(--sub);flex:none;margin-left:8px">${fmtDur(b.readMs)}</span></div>`).join('')}` : ''}`);
  $('#sheet').onclick = null;
}
async function fontSheet() {
  const fonts = await loadFonts();
  openSheet(`<h3><span>字型管理</span></h3>
    <div style="font-size:13px;color:var(--sub);margin-bottom:8px">可匯入 .ttf / .otf 字型檔（例如思源宋體、霞鶩文楷），匯入後在閱讀時「字體」裡選用。</div>
    ${fonts.map(f => `<div class="li" style="display:flex;justify-content:space-between;align-items:center"><span style="font-family:'${f.id}'">${esc(f.name)}　永遠的月讀</span><button class="btn warn" data-del="${f.id}">刪除</button></div>`).join('') || '<div class="empty" style="padding:20px">尚無自訂字型</div>'}
    <button class="btn pri" data-a="add" style="margin-top:10px">＋ 匯入字型檔</button>`);
  $('#sheet').onclick = async e => {
    if (e.target.closest('[data-a="add"]')) { const [f] = await pickFile('#fontIn', { accept: '' }); if (!f) return; if (!/\.(ttf|otf|woff2?)$/i.test(f.name)) return toast('請選 .ttf 或 .otf 檔'); busy('載入字型…'); await addFont(f); busy(); fontSheet(); }
    const d = e.target.closest('[data-del]'); if (d) { const fs = (await metaGet('fonts', [])).filter(x => x.id !== d.dataset.del); await metaSet('fonts', fs); if (R.settings.ff === d.dataset.del) { R.settings.ff = 'sans'; await saveSettings(); } fontSheet(); }
  };
}
