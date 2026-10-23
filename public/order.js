// On the Spot — customer page: send files to print, order supplies, track the order
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (v) => Number(v) || 0;
  const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
  const usd = (n) => '$' + num(n).toFixed(2);

  const S = {
    shop: null, products: [], categories: [], prices: [], extras: [],
    tab: 'print', cat: 'all', q: '',
    files: [],          // print jobs (one per uploaded file)
    cart: {},           // product_id -> qty
  };
  let uid = 0;

  const store = {
    get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };

  const lbp = (u) => {
    const rate = num(S.shop && S.shop.exchange_rate), round = num(S.shop && S.shop.lbp_round) || 1000;
    return (Math.round((num(u) * rate) / round) * round).toLocaleString('en-US') + ' LBP';
  };

  // WhatsApp link (Lebanese numbers: 03 123 456 -> 9613123456)
  function waLink(raw, text = '') {
    let d = String(raw || '').replace(/\D/g, '');
    if (!d) return '';
    if (d.startsWith('00')) d = d.slice(2);
    if (!d.startsWith('961')) d = '961' + d.replace(/^0/, '');
    return 'https://wa.me/' + d + (text ? '?text=' + encodeURIComponent(text) : '');
  }

  let toastTimer;
  function toast(msg, isError = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast show' + (isError ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.className = 'toast'), isError ? 4500 : 2600);
  }

  async function api(path, opts = {}) {
    let res;
    try {
      res = await fetch('/api/public' + path, {
        method: opts.method || 'GET',
        headers: { 'Content-Type': 'application/json' },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
    } catch { throw new Error('No internet connection. Check your Wi-Fi or mobile data and try again.'); }
    let data = null;
    try { data = await res.json(); } catch {}
    if (!res.ok) throw new Error((data && data.error) || 'Something went wrong. Please try again.');
    return data;
  }
  addEventListener('online', () => { if (!S.shop) location.reload(); });

  function openModal(html) {
    const root = $('#modal-root');
    root.innerHTML = `<div class="modal-backdrop"><div class="modal c-sheet" role="dialog" aria-modal="true">${html}</div></div>`;
    const bd = root.firstElementChild;
    bd.addEventListener('mousedown', (e) => { if (e.target === bd) closeModal(); });
    $$('[data-close]', root).forEach((b) => (b.onclick = closeModal));
    return $('.modal', root);
  }
  function closeModal() { $('#modal-root').innerHTML = ''; }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

  // ---------- prices ----------
  const sizes = () => {
    const list = [...new Set(S.prices.map((p) => p.size))];
    return list.sort((a, b) => (a === 'A4' ? -1 : b === 'A4' ? 1 : a.localeCompare(b)));
  };
  const perPage = (j) => {
    const p = S.prices.find((x) => x.color === j.color && x.size === j.size && x.sided === j.sided);
    return p ? num(p.price_per_page) : null;
  };
  function jobTotal(j) {
    const pp = perPage(j);
    if (pp === null || !(j.pages > 0) || !(j.copies > 0)) return 0;
    let t = j.pages * j.copies * pp;
    j.extras.forEach((id) => { const e = S.extras.find((x) => x.id === id); if (e) t += num(e.price) * j.copies; });
    return r2(t);
  }
  const productTotal = () => r2(Object.entries(S.cart).reduce((s, [id, q]) => {
    const p = S.products.find((x) => x.id === Number(id));
    return s + (p ? num(p.sell_price) * q : 0);
  }, 0));
  const printTotal = () => r2(S.files.reduce((s, j) => s + jobTotal(j), 0));
  const itemCount = () => S.files.length + Object.values(S.cart).reduce((s, q) => s + q, 0);

  // ---------- page counting ----------
  let pdfjsPromise = null;
  function loadPdfJs() {
    if (pdfjsPromise) return pdfjsPromise;
    pdfjsPromise = new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
      const t = setTimeout(() => resolve(null), 7000);
      s.onload = () => {
        clearTimeout(t);
        try { window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'; resolve(window.pdfjsLib); }
        catch { resolve(null); }
      };
      s.onerror = () => { clearTimeout(t); resolve(null); };
      document.head.appendChild(s);
    });
    return pdfjsPromise;
  }
  async function countPages(file, kind) {
    if (kind === 'image') return 1;
    if (kind !== 'pdf') return null;
    const buf = await file.arrayBuffer();
    const lib = await loadPdfJs();
    if (lib) {
      try { const doc = await lib.getDocument({ data: buf.slice(0) }).promise; return doc.numPages; } catch {}
    }
    // fallback: read the page tree straight from the PDF, including compressed object streams
    const bytes = new Uint8Array(buf);
    const txt = new TextDecoder('latin1').decode(bytes);
    const scan = (t) => ({
      count: Math.max(0, ...[...t.matchAll(/\/Type\s*\/Pages\b[^>]*?\/Count\s+(\d+)|\/Count\s+(\d+)[^>]*?\/Type\s*\/Pages\b/g)].map((m) => Number(m[1] || m[2]))),
      pages: (t.match(/\/Type\s*\/Page(?![a-zA-Z])/g) || []).length,
    });
    let best = scan(txt);
    if (!best.count && 'DecompressionStream' in window) {
      const re = /\/Type\s*\/ObjStm[\s\S]{0,600}?stream\r?\n/g;
      let m, n = 0;
      while ((m = re.exec(txt)) && n++ < 60) {
        const start = m.index + m[0].length;
        let end = txt.indexOf('endstream', start);
        if (end < 0) break;
        while (end > start && (bytes[end - 1] === 10 || bytes[end - 1] === 13)) end--;
        try {
          const out = await new Response(new Blob([bytes.slice(start, end)]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer();
          const r = scan(new TextDecoder('latin1').decode(new Uint8Array(out)));
          best = { count: Math.max(best.count, r.count), pages: best.pages + r.pages };
        } catch {}
      }
    }
    return best.count || best.pages || null;
  }

  const EXT_MIME = {
    pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif',
    doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  };
  function kindOf(file) {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    const mime = EXT_MIME[ext] || file.type || '';
    const kind = mime === 'application/pdf' ? 'pdf' : mime.startsWith('image/') ? 'image' : /word/.test(mime) ? 'word' : /powerpoint|presentation/.test(mime) ? 'slides' : '';
    return { mime, kind, ext };
  }
  const fmtSize = (b) => (b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');

  function addFiles(list) {
    const max = num(S.shop.max_file_mb) || 25;
    for (const file of list) {
      const { mime, kind, ext } = kindOf(file);
      if (!kind) { toast(`"${file.name}" can't be printed. Send PDF, Word, PowerPoint or photos.`, true); continue; }
      if (file.size > max * 1048576) { toast(`"${file.name}" is over ${max} MB.`, true); continue; }
      if (S.files.length >= 15) { toast('You can send up to 15 files in one order.', true); break; }
      const job = {
        uid: ++uid, file, name: file.name, bytes: file.size, mime, kind, ext,
        status: 'uploading', progress: 0, id: null, key: null,
        pages: null, pagesKnown: false,
        color: kind === 'image' ? 'color' : 'bw', size: sizes()[0] || 'A4', sided: 'single', copies: 1, extras: [],
      };
      S.files.push(job);
      upload(job);
      countPages(file, kind).then((n) => {
        if (n && !job.pagesTouched) { job.pages = n; job.pagesKnown = true; }
        renderFiles(); renderBar();
      });
    }
    renderFiles(); renderBar();
  }

  function upload(job) {
    const xhr = new XMLHttpRequest();
    job.xhr = xhr;
    xhr.open('POST', '/api/public/uploads');
    xhr.setRequestHeader('Content-Type', job.mime);
    xhr.setRequestHeader('X-Filename', encodeURIComponent(job.name));
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) { job.progress = Math.round((e.loaded / e.total) * 100); paintProgress(job); } };
    xhr.onload = () => {
      let d = null;
      try { d = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status === 200 && d && d.id) { job.status = 'ready'; job.id = d.id; job.key = d.key; }
      else { job.status = 'error'; job.error = (d && d.error) || 'Upload failed.'; }
      renderFiles(); renderBar();
    };
    xhr.onerror = () => { job.status = 'error'; job.error = 'Upload failed. Check your connection.'; renderFiles(); renderBar(); };
    xhr.send(job.file);
  }
  function paintProgress(job) {
    const bar = $(`[data-prog="${job.uid}"]`);
    if (bar) bar.style.width = job.progress + '%';
    const lab = $(`[data-proglab="${job.uid}"]`);
    if (lab) lab.textContent = `Uploading ${job.progress}%`;
  }

  // ================= views =================
  function shell(inner) { $('#c-view').innerHTML = inner; window.scrollTo({ top: 0 }); }

  function renderHome() {
    document.title = `${S.shop.name} — Order online`;
    if (!S.shop.enabled) {
      shell(`<section class="c-hero"><h1>Online orders are <span class="grad-text">paused</span></h1>
        <p class="c-sub">Please contact the shop directly.</p>${shopInfo()}</section>`);
      renderBar(); return;
    }
    shell(`
      <section class="c-hero">
        <h1>Print it. <span class="grad-text">Pick it up.</span></h1>
        <p class="c-sub">Send your files from your phone and order supplies. We get everything ready, you pay when you pick it up.</p>
      </section>
      <div class="c-tabs" role="tablist">
        <button type="button" role="tab" data-tab="print" aria-selected="${S.tab === 'print'}"><span class="c-tab-obj" aria-hidden="true">${objSvg('sheet')}</span><span><strong>Print files</strong><small>PDF, Word, photos</small></span></button>
        <button type="button" role="tab" data-tab="shop" aria-selected="${S.tab === 'shop'}"><span class="c-tab-obj" aria-hidden="true">${objSvg('notebook')}</span><span><strong>Shop supplies</strong><small>Copybooks, pens…</small></span></button>
      </div>
      <section id="c-print" ${S.tab === 'print' ? '' : 'hidden'}></section>
      <section id="c-shop" ${S.tab === 'shop' ? '' : 'hidden'}></section>
      ${shopInfo()}`);
    $$('[data-tab]').forEach((b) => (b.onclick = () => { S.tab = b.dataset.tab; renderHome(); }));
    if (S.tab === 'print') renderPrint(); else renderShop();
    renderBar();
  }

  const objSvg = (n) => (window.objSvg ? window.objSvg(n) : '');

  function shopInfo() {
    const s = S.shop;
    const rows = [];
    if (s.address) rows.push(`<div><span class="muted">Address</span><strong>${esc(s.address)}</strong></div>`);
    if (s.hours) rows.push(`<div><span class="muted">Open</span><strong>${esc(s.hours)}</strong></div>`);
    rows.push(`<div><span class="muted">Payment</span><strong>At pickup, in $ or LBP</strong></div>`);
    return `<section class="c-info glass">${rows.join('')}${s.whatsapp ? `<a class="btn btn-block" href="${waLink(s.whatsapp)}" target="_blank" rel="noopener">Message us on WhatsApp</a>` : ''}</section>`;
  }

  // ---------- print tab ----------
  function renderPrint() {
    const sec = $('#c-print');
    if (!S.prices.length) { sec.innerHTML = `<div class="empty glass c-empty">Printing isn't available online right now.</div>`; return; }
    sec.innerHTML = `
      <label class="drop glass" id="drop">
        <input type="file" id="file-input" multiple accept=".pdf,.doc,.docx,.ppt,.pptx,.jpg,.jpeg,.png,.webp,.heic,image/*,application/pdf">
        <span class="drop-obj" aria-hidden="true">${objSvg('sheet')}</span>
        <strong>Add files to print</strong>
        <span class="muted">Tap to choose, or drop files here. Up to ${num(S.shop.max_file_mb) || 25} MB each.</span>
      </label>
      <div id="file-list" class="file-list"></div>`;
    const input = $('#file-input');
    input.onchange = () => { addFiles([...input.files]); input.value = ''; };
    const drop = $('#drop');
    ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
    drop.addEventListener('drop', (e) => addFiles([...e.dataTransfer.files]));
    renderFiles();
  }

  const KIND_LABEL = { pdf: 'PDF', image: 'Photo', word: 'Word', slides: 'Slides' };
  function renderFiles() {
    const list = $('#file-list');
    if (!list) return;
    list.innerHTML = S.files.map((j) => {
      const pp = perPage(j);
      const total = jobTotal(j);
      const statusHtml = j.status === 'uploading'
        ? `<div class="prog"><i data-prog="${j.uid}" style="width:${j.progress}%"></i></div><span class="muted small" data-proglab="${j.uid}">Uploading ${j.progress}%</span>`
        : j.status === 'error' ? `<span class="err small">${esc(j.error)}</span>` : `<span class="ok small">Uploaded</span>`;
      return `<article class="file-card glass" data-uid="${j.uid}">
        <div class="fc-head">
          <span class="fc-kind fc-${j.kind}">${KIND_LABEL[j.kind]}</span>
          <div class="fc-name"><strong title="${esc(j.name)}">${esc(j.name)}</strong><span class="muted small">${fmtSize(j.bytes)}</span></div>
          <button type="button" class="qty-btn" data-remove="${j.uid}" aria-label="Remove file">×</button>
        </div>
        <div class="fc-status">${statusHtml}</div>
        <div class="fc-opts">
          <div class="seg" data-f="color"><button type="button" data-v="bw" aria-pressed="${j.color === 'bw'}">B&amp;W</button><button type="button" data-v="color" aria-pressed="${j.color === 'color'}">Color</button></div>
          <div class="seg" data-f="size">${sizes().map((s) => `<button type="button" data-v="${esc(s)}" aria-pressed="${j.size === s}">${esc(s)}</button>`).join('')}</div>
          <div class="seg" data-f="sided"><button type="button" data-v="single" aria-pressed="${j.sided === 'single'}">1-sided</button><button type="button" data-v="double" aria-pressed="${j.sided === 'double'}">2-sided</button></div>
        </div>
        <div class="fc-nums">
          <label>Pages ${j.pagesKnown ? '<span class="muted">(counted)</span>' : ''}<input type="number" min="1" step="1" inputmode="numeric" data-n="pages" value="${j.pages ?? ''}" placeholder="${j.kind === 'pdf' ? 'Counting…' : 'How many?'}"></label>
          <label>Copies<input type="number" min="1" step="1" inputmode="numeric" data-n="copies" value="${j.copies}"></label>
        </div>
        ${S.extras.length ? `<div class="fc-extras">${S.extras.map((e) => `<button type="button" class="chip" data-extra="${e.id}" aria-pressed="${j.extras.includes(e.id)}">${esc(e.name)} <span class="muted">+${usd(e.price)}</span></button>`).join('')}</div>` : ''}
        <div class="fc-foot"><span class="muted small">${pp === null ? 'This option is not available' : j.pages ? `${j.pages * j.copies} pages × $${pp.toFixed(3).replace(/0$/, '')}` : 'Enter the number of pages'}</span><strong class="fc-total">${usd(total)}</strong></div>
      </article>`;
    }).join('');

    $$('.file-card', list).forEach((card) => {
      const j = S.files.find((x) => x.uid === Number(card.dataset.uid));
      $$('.seg', card).forEach((seg) => $$('button', seg).forEach((b) => (b.onclick = () => { j[seg.dataset.f] = b.dataset.v; renderFiles(); renderBar(); })));
      $$('[data-extra]', card).forEach((b) => (b.onclick = () => {
        const id = Number(b.dataset.extra);
        j.extras = j.extras.includes(id) ? j.extras.filter((x) => x !== id) : [...j.extras, id];
        renderFiles(); renderBar();
      }));
      $$('[data-n]', card).forEach((inp) => inp.addEventListener('change', () => {
        const v = Math.max(0, parseInt(inp.value, 10) || 0);
        if (inp.dataset.n === 'pages') { j.pages = v || null; j.pagesKnown = false; j.pagesTouched = true; } else j.copies = Math.max(1, v);
        renderFiles(); renderBar();
      }));
      $('[data-remove]', card).onclick = () => {
        if (j.xhr && j.status === 'uploading') j.xhr.abort();
        S.files = S.files.filter((x) => x !== j);
        renderFiles(); renderBar();
      };
    });
  }

  // ---------- shop tab ----------
  function renderShop() {
    const sec = $('#c-shop');
    if (!S.products.length) { sec.innerHTML = `<div class="empty glass c-empty">No products online yet.</div>`; return; }
    sec.innerHTML = `
      <input type="search" class="c-search" id="c-q" placeholder="Search copybooks, pens, glue…" value="${esc(S.q)}" autocomplete="off">
      <div class="chips" id="c-cats"></div>
      <div class="c-grid" id="c-grid"></div>`;
    $('#c-q').oninput = (e) => { S.q = e.target.value; drawProducts(); };
    const cats = [{ id: 'all', name: 'All' }, ...S.categories];
    $('#c-cats').innerHTML = cats.map((c) => `<button type="button" class="chip" data-cat="${c.id}" aria-pressed="${String(S.cat) === String(c.id)}">${esc(c.name)}</button>`).join('');
    $$('#c-cats .chip').forEach((b) => (b.onclick = () => { S.cat = b.dataset.cat; renderShop(); }));
    drawProducts();
  }
  // a matching 3D drawing when a product has no photo yet
  function guessObj(name) {
    const n = String(name).toLowerCase();
    if (/pencil|crayon|colou?r/.test(n)) return 'pencil';
    if (/pen|marker|highlight/.test(n)) return 'pen';
    if (/eraser|gomme/.test(n)) return 'eraser';
    if (/paper|sheet|a4|card|envelope/.test(n)) return 'sheet';
    if (/clip|stapl|pin/.test(n)) return 'clip';
    return 'notebook';
  }
  function drawProducts() {
    const q = S.q.trim().toLowerCase();
    const inkOf = (cid) => { const i = S.categories.findIndex((c) => c.id === cid); return i < 0 ? 'k' : ['c', 'm', 'y', 'k'][i % 4]; };
    const list = S.products.filter((p) => (S.cat === 'all' || String(p.category_id) === String(S.cat)) && (!q || p.name.toLowerCase().includes(q)));
    $('#c-grid').innerHTML = list.length ? list.map((p) => {
      const qty = S.cart[p.id] || 0;
      return `<div class="tile c-prod" data-ink="${inkOf(p.category_id)}">
        <div class="c-img">${p.image_v ? `<img src="/api/products/${p.id}/image?v=${p.image_v}" alt="${esc(p.name)}" loading="lazy">` : `<span class="c-img-none" aria-hidden="true">${objSvg(guessObj(p.name))}</span>`}</div>
        <span class="t-name">${esc(p.name)}</span>
        <span class="t-foot"><span class="t-price num">${usd(p.sell_price)}</span>
        ${!p.in_stock ? '<span class="t-stock">Out of stock</span>'
          : qty ? `<span class="c-step"><button type="button" class="qty-btn" data-dec="${p.id}" aria-label="One less">−</button><span class="qty-val">${qty}</span><button type="button" class="qty-btn" data-inc="${p.id}" aria-label="One more">+</button></span>`
          : `<button type="button" class="btn btn-sm c-add" data-inc="${p.id}">Add</button>`}</span>
      </div>`;
    }).join('') : `<div class="empty" style="grid-column:1/-1">Nothing matches your search.</div>`;
    $$('[data-inc]', $('#c-grid')).forEach((b) => (b.onclick = () => {
      const p = S.products.find((x) => x.id === Number(b.dataset.inc));
      const q2 = (S.cart[p.id] || 0) + 1;
      if (q2 > num(p.max_qty)) return toast(`Only ${p.max_qty} available.`, true);
      S.cart[p.id] = q2; drawProducts(); renderBar();
    }));
    $$('[data-dec]', $('#c-grid')).forEach((b) => (b.onclick = () => {
      const id = Number(b.dataset.dec);
      S.cart[id] = (S.cart[id] || 0) - 1;
      if (S.cart[id] <= 0) delete S.cart[id];
      drawProducts(); renderBar();
    }));
  }

  // ---------- bottom bar + checkout ----------
  function renderBar() {
    const bar = $('#c-bar');
    const n = itemCount();
    const onHome = !location.pathname.startsWith('/track');
    bar.hidden = !(onHome && n > 0 && S.shop && S.shop.enabled);
    document.body.classList.toggle('has-bar', !bar.hidden);
    if (bar.hidden) return;
    const total = r2(printTotal() + productTotal());
    $('#c-bar-btn').innerHTML = `<span>Review order · ${n} item${n === 1 ? '' : 's'}</span><span class="c-bar-total">${usd(total)}</span>`;
    $('#c-bar-btn').onclick = openCheckout;
  }

  function openCheckout() {
    const uploading = S.files.some((j) => j.status === 'uploading');
    const failed = S.files.filter((j) => j.status === 'error');
    const missingPages = S.files.filter((j) => j.status !== 'error' && !(j.pages > 0));
    const lines = [
      ...S.files.filter((j) => j.status !== 'error').map((j) => `<div class="sum-line"><span><strong>${esc(j.name)}</strong><small class="muted">${j.color === 'bw' ? 'B&W' : 'Color'} ${esc(j.size)}, ${j.sided === 'single' ? '1-sided' : '2-sided'}, ${j.pages || '?'} pg × ${j.copies}${j.extras.length ? ' + ' + j.extras.map((id) => (S.extras.find((e) => e.id === id) || {}).name).join(', ') : ''}</small></span><span class="num">${usd(jobTotal(j))}</span></div>`),
      ...Object.entries(S.cart).map(([id, q]) => { const p = S.products.find((x) => x.id === Number(id)); return p ? `<div class="sum-line"><span><strong>${esc(p.name)}</strong><small class="muted">${q} × ${usd(p.sell_price)}</small></span><span class="num">${usd(num(p.sell_price) * q)}</span></div>` : ''; }),
    ].join('');
    const total = r2(printTotal() + productTotal());
    const saved = store.get('ots_customer', {});
    const m = openModal(`
      <div class="modal-head"><h2>Your order</h2><button class="btn btn-ghost btn-sm" data-close>Close</button></div>
      <div class="sum-lines">${lines || '<div class="muted">Nothing yet.</div>'}</div>
      <div class="sum-row c-total"><span>Total</span><span><span class="sum-total num">${usd(total)}</span><small class="muted num">${lbp(total)}</small></span></div>
      ${failed.length ? `<p class="form-error">${failed.length} file${failed.length > 1 ? 's' : ''} failed to upload and won't be sent. Remove ${failed.length > 1 ? 'them' : 'it'} or add again.</p>` : ''}
      ${missingPages.length ? `<p class="form-error">Enter the number of pages for: ${missingPages.map((j) => esc(j.name)).join(', ')}</p>` : ''}
      <form id="c-form" class="c-form">
        <label>Your name<input name="name" required autocomplete="name" value="${esc(saved.name || '')}" placeholder="Full name"></label>
        <label>Phone (WhatsApp)<input name="phone" required type="tel" autocomplete="tel" inputmode="tel" value="${esc(saved.phone || '')}" placeholder="03 123 456"></label>
        <label>Note for the shop <span class="muted">(optional)</span><textarea name="note" rows="2" maxlength="500" placeholder="e.g. staple each copy, pick up after 4 pm"></textarea></label>
        <p class="c-pay-note">You pay when you pick it up, in $ or LBP. We'll tell you when it's ready.</p>
        <p class="form-error" id="c-err"></p>
        <button class="btn btn-charge btn-block" type="submit" ${uploading || missingPages.length || !lines ? 'disabled' : ''}>${uploading ? 'Waiting for uploads…' : 'Send order'}</button>
      </form>`);
    $('#c-form', m).onsubmit = async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      const btn = $('button[type=submit]', e.target);
      btn.disabled = true; btn.textContent = 'Sending…';
      const items = [
        ...S.files.filter((j) => j.status === 'ready').map((j) => ({ type: 'print', file_id: j.id, file_key: j.key, color: j.color, size: j.size, sided: j.sided, pages: j.pages, copies: j.copies, extras: j.extras })),
        ...Object.entries(S.cart).map(([id, q]) => ({ type: 'product', product_id: Number(id), qty: q })),
      ];
      try {
        const r = await api('/orders', { method: 'POST', body: { name: f.name, phone: f.phone, note: f.note, items } });
        store.set('ots_customer', { name: f.name, phone: f.phone });
        const mine = store.get('ots_orders', []).filter((o) => o.token !== r.token);
        mine.unshift({ token: r.token, code: r.code, at: Date.now() });
        store.set('ots_orders', mine.slice(0, 10));
        S.files = []; S.cart = {};
        closeModal();
        history.pushState({}, '', '/track/' + r.token);
        route(true);
      } catch (err) {
        $('#c-err', m).textContent = err.message;
        btn.disabled = false; btn.textContent = 'Send order';
      }
    };
  }

  // ---------- tracking ----------
  const STEPS = [
    ['received', 'Received', 'The shop has your order.'],
    ['preparing', 'Preparing', 'We are printing and packing it.'],
    ['ready', 'Ready for pickup', 'Come pick it up and pay at the shop.'],
    ['picked_up', 'Picked up', 'Thank you! See you soon.'],
  ];
  let trackTimer = null;
  async function renderTrack(token, fresh = false) {
    clearTimeout(trackTimer);
    let o;
    try { o = await api('/orders/' + encodeURIComponent(token)); }
    catch (err) { shell(`<section class="c-hero"><h1>Order not <span class="grad-text">found</span></h1><p class="c-sub">${esc(err.message)}</p><a class="btn btn-primary" href="/order">Start a new order</a></section>`); renderBar(); return; }
    document.title = `Order ${o.code} — ${o.shop.name}`;
    const idx = STEPS.findIndex((s) => s[0] === o.status);
    const cancelled = o.status === 'cancelled';
    const cur = STEPS[idx] || null;
    const rateTotal = (() => { const r = num(o.shop.exchange_rate), rd = num(o.shop.lbp_round) || 1000; return (Math.round((num(o.total_usd) * r) / rd) * rd).toLocaleString('en-US') + ' LBP'; })();
    shell(`
      ${fresh ? `<div class="c-sent"><span class="c-sent-obj" aria-hidden="true">${objSvg('plane')}</span><strong>Order sent!</strong><span class="muted">Save this page to check your order anytime.</span></div>` : ''}
      <section class="c-track glass">
        <div class="c-code"><span class="muted">Order</span><strong>#${esc(o.code)}</strong><span class="muted small">Show this code at the shop</span></div>
        ${cancelled ? `<div class="c-cancelled">This order was cancelled.</div>` : `
        <ol class="c-steps">${STEPS.map((s, i) => `<li class="${i < idx ? 'done' : i === idx ? 'now' : ''}"><span class="dot"></span><span><strong>${s[1]}</strong>${i === idx ? `<small>${s[2]}</small>` : ''}</span></li>`).join('')}</ol>`}
        <div class="sum-lines">${o.items.map((i) => `<div class="sum-line"><span><strong>${esc(i.item_type === 'print' ? 'Print' : i.description)}</strong><small class="muted">${esc(i.item_type === 'print' ? i.description : i.qty + ' pcs')}</small></span><span class="num">${usd(i.line_total)}</span></div>`).join('')}</div>
        <div class="sum-row c-total"><span>To pay at pickup</span><span><span class="sum-total num">${usd(o.total_usd)}</span><small class="muted num">${rateTotal}</small></span></div>
        <div class="c-track-actions">
          ${o.shop.whatsapp ? `<a class="btn btn-block" target="_blank" rel="noopener" href="${waLink(o.shop.whatsapp, `Hi, about my order #${o.code}`)}">Message the shop</a>` : ''}
          ${o.status === 'received' ? '<button class="btn btn-danger btn-block" id="c-cancel" type="button">Cancel order</button>' : ''}
          <a class="btn btn-ghost btn-block" href="/order">New order</a>
        </div>
      </section>
      ${!cancelled && o.status !== 'picked_up' ? '<p class="muted small c-auto">This page updates by itself.</p>' : ''}`);
    const c = $('#c-cancel');
    if (c) c.onclick = async () => {
      if (!confirm('Cancel this order?')) return;
      try { await api(`/orders/${encodeURIComponent(token)}/cancel`, { method: 'POST' }); toast('Order cancelled'); renderTrack(token); }
      catch (err) { toast(err.message, true); }
    };
    renderBar();
    if (!cancelled && o.status !== 'picked_up') trackTimer = setTimeout(() => { if (location.pathname === '/track/' + token) renderTrack(token); }, 15000);
  }

  function showMyOrders() {
    const mine = store.get('ots_orders', []);
    const m = openModal(`<div class="modal-head"><h2>My orders</h2><button class="btn btn-ghost btn-sm" data-close>Close</button></div>
      ${mine.length ? `<div class="sum-lines">${mine.map((o) => `<a class="sum-line c-link" href="/track/${esc(o.token)}"><span><strong>#${esc(o.code)}</strong><small class="muted">${new Date(o.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</small></span><span>View</span></a>`).join('')}</div>` : '<p class="muted">No orders on this phone yet.</p>'}`);
    $$('.c-link', m).forEach((a) => (a.onclick = (e) => { e.preventDefault(); closeModal(); history.pushState({}, '', a.getAttribute('href')); route(); }));
  }

  // ---------- routing ----------
  function route(fresh = false) {
    clearTimeout(trackTimer);
    const m = location.pathname.match(/^\/track\/([a-f0-9]+)/);
    $('#c-my-orders').hidden = !store.get('ots_orders', []).length;
    if (m) renderTrack(m[1], fresh); else renderHome();
  }
  window.addEventListener('popstate', () => route());
  $('#c-my-orders').onclick = showMyOrders;
  if (window.otsInstall) {
    window.otsInstall.onChange(() => { $('#c-install').hidden = !window.otsInstall.available(); });
    $('#c-install').onclick = () => window.otsInstall.prompt(() => openModal(window.otsInstall.iosHelpHtml('On the Spot')));
  }
  window.addEventListener('beforeunload', (e) => { if (itemCount() && !location.pathname.startsWith('/track')) { e.preventDefault(); e.returnValue = ''; } });

  (async function boot() {
    try {
      const d = await api('/shop');
      Object.assign(S, { shop: d.shop, products: d.products, categories: d.categories, prices: d.prices, extras: d.extras });
      $('#c-shop-name').textContent = d.shop.name;
      route();
    } catch (err) {
      shell(`<section class="c-hero"><h1>${navigator.onLine ? "Can't load the" : 'No'} <span class="grad-text">${navigator.onLine ? 'shop' : 'internet'}</span></h1><p class="c-sub">${esc(err.message)}</p><button class="btn btn-primary" onclick="location.reload()">Try again</button></section>`);
    }
  })();
})();
