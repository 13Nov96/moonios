'use strict';
/* 月讀 extras: TTS, auto page, PIN lock, WiFi transfer, boot */

/* ---------- control pill ---------- */
function ctlShow(html, onClick) { const c = $('#ctl'); c.innerHTML = html; c.classList.remove('hidden'); c.onclick = onClick; }
function ctlHide() { $('#ctl').classList.add('hidden'); }

/* ---------- TTS ---------- */
const T = { on: false, paused: false, sents: [], i: 0, gen: 0 };
function ttsVoice() {
  const vs = speechSynthesis.getVoices();
  return vs.find(v => v.name === R.settings.ttsVoice) || vs.find(v => /zh[-_]TW/i.test(v.lang)) || vs.find(v => /zh/i.test(v.lang)) || null;
}
function ttsBar() {
  ctlShow(`<button data-a="pp">${T.paused ? '▶ 繼續' : '⏸ 暫停'}</button><button data-a="slow">−</button><span>${R.settings.ttsRate.toFixed(1)}x</span><button data-a="fast">＋</button><button data-a="voice">聲音</button><button data-a="x">✕</button>`, async e => {
    const a = e.target.closest('[data-a]')?.dataset.a; if (!a) return;
    if (a === 'pp') ttsToggle();
    if (a === 'x') ttsStop();
    if (a === 'slow' || a === 'fast') { R.settings.ttsRate = Math.max(0.5, Math.min(2.5, R.settings.ttsRate + (a === 'fast' ? 0.1 : -0.1))); saveSettings(); if (!T.paused) { speechSynthesis.cancel(); ttsSpeak(); } ttsBar(); }
    if (a === 'voice') {
      const vs = speechSynthesis.getVoices().filter(v => /zh|yue|cmn/i.test(v.lang)); if (!vs.length) return toast('找不到中文語音');
      const cur = ttsVoice(); const nx = vs[(vs.indexOf(cur) + 1) % vs.length]; R.settings.ttsVoice = nx.name; saveSettings(); toast(nx.name + '（' + nx.lang + '）');
      if (!T.paused) { speechSynthesis.cancel(); ttsSpeak(); }
    }
  });
}
function ttsSplit(from) {
  const text = ct().textContent; const out = []; const re = /[^。！？!?；;…\n]+[。！？!?；;…」』”"）)]*/g; let m;
  while ((m = re.exec(text))) { const s = m.index, e = s + m[0].length; if (e <= from) continue; if (m[0].trim()) out.push({ s: Math.max(s, from), e, t: text.slice(Math.max(s, from), e) }); }
  return out;
}
async function ttsStart() {
  if (!('speechSynthesis' in window)) return toast('此裝置不支援朗讀');
  if (R.pdf) return toast('PDF 暫不支援朗讀');
  autoStop(); T.on = true; T.paused = false; T.sents = ttsSplit(currentOffset()); T.i = 0; ttsBar(); ttsSpeak(); wakeOn();
}
function ttsSpeak() {
  if (!T.on || T.paused) return;
  const gen = ++T.gen;
  if (T.i >= T.sents.length) {
    if (R.chapter < R.src.count - 1) { showChapter(R.chapter + 1).then(() => { if (gen !== T.gen) return; T.sents = ttsSplit(0); T.i = 0; ttsSpeak(); }); }
    else { ttsStop(); toast('全書朗讀完'); }
    return;
  }
  const s = T.sents[T.i];
  const u = new SpeechSynthesisUtterance(s.t); u.lang = 'zh-TW'; u.rate = R.settings.ttsRate; const v = ttsVoice(); if (v) u.voice = v;
  u.onstart = () => { if (gen !== T.gen) return; ttsMark(s); };
  u.onend = () => { if (gen !== T.gen) return; T.i++; ttsSpeak(); };
  u.onerror = ev => { if (gen !== T.gen || ev.error === 'interrupted' || ev.error === 'canceled') return; T.i++; setTimeout(ttsSpeak, 50); };
  speechSynthesis.speak(u);
}
function ttsMark(s) {
  touchActive();
  try {
    const a = textPoint(ct(), s.s), b = textPoint(ct(), Math.max(s.s, s.e - 1));
    if (a && b && window.CSS && CSS.highlights) { const r = document.createRange(); r.setStart(a[0], a[1]); r.setEnd(b[0], Math.min(b[0].data.length, b[1] + 1)); CSS.highlights.set('tts', new Highlight(r)); }
  } catch (e) {}
  if (R.paged) { const p = pageOfOffset(s.s); if (p !== R.page) goPage(p, true); }
  else { const rc = rectAt(s.s); const v = visibleBox(); if (rc && (rc.top < v.t || rc.bottom > v.b - 20)) pg().scrollTop += rc.top - v.t - 40; }
}
function ttsToggle() { if (!T.on) return; T.paused = !T.paused; T.gen++; speechSynthesis.cancel(); if (!T.paused) ttsSpeak(); ttsBar(); }
function ttsStop() { if (!T.on) return; T.on = false; T.gen++; try { speechSynthesis.cancel(); } catch (e) {} try { CSS.highlights && CSS.highlights.delete('tts'); } catch (e) {} ctlHide(); saveProgress(); }
$('#bTts').onclick = () => { showBars(false); T.on ? ttsStop() : ttsStart(); };
if ('speechSynthesis' in window) speechSynthesis.getVoices();

/* ---------- auto page / scroll ---------- */
const A = { on: false, paused: false, t: 0, last: 0, acc: 0 };
const PAGE_SEC = [45, 36, 29, 24, 20, 16, 13, 10, 8];
function autoBar() {
  ctlShow(`<button data-a="pp">${A.paused ? '▶ 繼續' : '⏸ 暫停'}</button><button data-a="slow">−</button><span>速度 ${R.settings.autoSpeed}</span><button data-a="fast">＋</button><button data-a="x">✕</button>`, e => {
    const a = e.target.closest('[data-a]')?.dataset.a; if (!a) return;
    if (a === 'pp') autoToggle(); if (a === 'x') autoStop();
    if (a === 'slow' || a === 'fast') { R.settings.autoSpeed = Math.max(1, Math.min(9, R.settings.autoSpeed + (a === 'fast' ? 1 : -1))); saveSettings(); A.acc = 0; autoBar(); }
  });
}
function autoStart() { ttsStop(); A.on = true; A.paused = false; A.last = performance.now(); A.acc = 0; autoBar(); wakeOn(); requestAnimationFrame(autoTick); }
async function autoTick(now) {
  if (!A.on) return;
  const dt = (now - A.last) / 1000; A.last = now;
  if (!A.paused && !A.busy) {
    if (R.paged || R.pdf && false) { A.acc += dt; if (A.acc >= PAGE_SEC[R.settings.autoSpeed - 1]) { A.acc = 0; A.busy = true; await nextPage(); A.busy = false; } }
    else { const p = pg(); A.acc += dt * R.settings.autoSpeed * 11; const px = Math.floor(A.acc); if (px >= 1) { A.acc -= px; if (p.scrollTop + p.clientHeight >= p.scrollHeight - 2) { A.busy = true; await nextPage(); A.busy = false; } else p.scrollTop += px; touchActive(); } }
  }
  requestAnimationFrame(autoTick);
}
function autoToggle() { A.paused = !A.paused; A.acc = 0; autoBar(); }
function autoStop() { if (!A.on) return; A.on = false; ctlHide(); }

/* ---------- 4-digit lock ---------- */
async function pinHash(pin, salt) { const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(salt + ':' + pin)); return Array.from(new Uint8Array(d), b => b.toString(16).padStart(2, '0')).join(''); }
async function pinSet(pin) { if (!pin) { await dbDel('meta', 'pin'); hasPin = false; return; } const salt = uid(); await metaSet('pin', { salt, hash: await pinHash(pin, salt) }); hasPin = true; }
async function pinCheck(pin) { const p = await metaGet('pin', null); return !p || (await pinHash(pin, p.salt)) === p.hash; }
let lockState = null, hasPin = false, locking = false;
function askPin(title, cancelable) {
  return new Promise(res => {
    lockState = { buf: '', res, cancelable }; $('#lkT').textContent = title; drawDots();
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
    if (await confirmBox('忘記密碼', '只能清除全部資料（書、進度、畫線）重新開始，無法復原。', '清除全部', 'warn')) { _db && _db.close(); _db = null; indexedDB.deleteDatabase('moonios'); setTimeout(() => location.reload(), 300); }
    return;
  }
  if (st.buf.length >= 4) return;
  st.buf += b.textContent; drawDots();
  if (st.buf.length === 4) { const v = st.buf; await sleep(120); if (lockState === st) { lockState = null; st.res(v); } }
});
function failShake() { const d = $('#lkDots'); d.classList.remove('shake'); void d.offsetWidth; d.classList.add('shake'); }
async function lockIfNeeded() {
  if (locking || !hasPin) return;
  locking = true; $('#lock').classList.remove('hidden');
  if (T.on && !T.paused) ttsToggle();
  for (;;) { const v = await askPin('輸入密碼', false); if (await pinCheck(v)) break; failShake(); }
  $('#lock').classList.add('hidden'); locking = false;
}
async function pinMenu(has) {
  if (has) {
    const r = await modal('密碼設定', '每次開啟或切回月讀時都要輸入。', [['關閉密碼', 'off'], ['變更密碼', 'chg'], ['取消', null, 'pri']]); if (!r) return;
    const cur = await askPin('輸入目前密碼', true); if (cur === null) return;
    if (!(await pinCheck(cur))) { $('#lock').classList.add('hidden'); toast('密碼錯誤'); return; }
    if (r === 'off') { $('#lock').classList.add('hidden'); await pinSet(''); toast('已關閉密碼'); return; }
  }
  const a = await askPin('設定 4 位數密碼', true); if (a === null) return;
  const b = await askPin('再輸入一次', true); $('#lock').classList.add('hidden'); if (b === null) return;
  if (a !== b) { toast('兩次不一致，未設定'); return; }
  await pinSet(a); toast('已設定密碼');
}
document.addEventListener('visibilitychange', () => { if (document.hidden && hasPin && !xfer.peer) { $('#lock').classList.remove('hidden'); lockIfNeeded(); } });

/* ---------- WiFi 傳書 (WebRTC via PeerJS signaling) ---------- */
const xfer = { peer: null };
function peerOpts() { const q = new URLSearchParams(location.search).get('ps'); if (!q) return { debug: 0 }; const [host, port] = q.split(':'); return { host, port: +port || 9000, path: '/', secure: false, debug: 0 }; }
function upURL() { return location.host + location.pathname.replace(/[^/]*$/, '') + 'up'; }
async function openTransfer() {
  if (typeof Peer === 'undefined') return toast('傳書元件載入失敗');
  if (!navigator.onLine) return modal('需要網路', 'WiFi 傳書配對需要網路連線（書檔本身直接在兩台裝置間傳送）。請連上可上網的 WiFi 後再試。');
  closePeer(); $('#xRx').innerHTML = ''; $('#xUrl').textContent = upURL(); $('#xfer').classList.remove('hidden');
  pushLayer('xfer', () => { closePeer(); $('#xfer').classList.add('hidden'); renderLib(); });
  wakeOn(); startPeer();
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
      if (d.t === 'end' && cur) { batch.push(new File(cur.parts, cur.name)); cur.el.textContent = `✓ ${cur.name}`; conn.send({ t: 'ack', name: cur.name }); cur = null; }
      if (d.t === 'done') {
        const files = batch.splice(0); $('#xSt').textContent = `收到 ${files.length} 個檔案，匯入中…`; conn.send({ t: 'importing' });
        const p = handleFiles(files); await sleep(50);
        const until = setInterval(() => { if ($('#modal').classList.contains('hidden') === false && $('#busy').classList.contains('hidden')) { clearInterval(until); conn.send({ t: 'imported', n: files.length }); } }, 200);
        await p; clearInterval(until); conn.send({ t: 'imported', n: files.length });
        $('#xSt').textContent = `已匯入 ${files.length} 個檔案。可繼續傳送。`;
      }
    });
    conn.on('close', () => { if (xfer.peer === peer) $('#xSt').textContent = '電腦已中斷，等待重新連線…'; });
  });
}
function closePeer() { if (xfer.peer) { try { xfer.peer.destroy(); } catch (e) {} xfer.peer = null; } }
$('#xNew').onclick = startPeer;
$('#xClose').onclick = () => backLayer('xfer');

/* ---------- boot ---------- */
(async () => {
  await openDB();
  await loadSettings();
  hasPin = !!(await metaGet('pin', null));
  if (hasPin) $('#lock').classList.remove('hidden');
  Object.assign(L, await metaGet('libui', {}));
  // migrate v1/v2 data
  for (const b of await dbAll('books')) {
    let ch = false;
    if ((b.shelves || []).includes('★ 最愛')) { b.favorite = true; b.shelves = b.shelves.filter(s => s !== '★ 最愛'); ch = true; }
    if (b.readMs === undefined) { b.readMs = 0; ch = true; }
    if (b.folder === undefined) { b.folder = parentDir(b.path || ''); ch = true; }
    if (b.fmt === 'pdf' && !b.cover && !b.coverTried) { b.coverTried = true; b.cover = await pdfCover(b.blob); ch = true; }
    if (ch) await dbPut('books', b);
  }
  try { history.replaceState({ layer: 'root' }, ''); } catch (e) {}
  await renderLib();
  lockIfNeeded();
  const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  if (!standalone && /iPhone|iPad/.test(navigator.userAgent) && !(await metaGet('a2hs', false))) {
    await modal('加到主畫面', '請按 Safari 下方「分享」→「加入主畫面」，之後從主畫面圖示開啟。<br>這樣才能離線使用，書與筆記也才會長期保存在手機裡。', [['知道了', true]]);
    await metaSet('a2hs', true);
  }
  if (navigator.serviceWorker) navigator.serviceWorker.addEventListener('controllerchange', () => { if (!R.book) toast('月讀已更新'); });
})();
window.__moon = { handleFiles, dbAll, openBook, R, L, pinSet };
