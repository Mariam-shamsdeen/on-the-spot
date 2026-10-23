// On the Spot — front end (vanilla JS)
(() => {
  // ================= state =================
  const state = {
    token: null,
    user: null,
    settings: {},
    products: [],
    categories: [],
    printPrices: [],
    printExtras: [],
    cart: [],          // {key, type:'product', product_id, name, price, qty, stock} | {key, type:'print', ...opts, desc, price}
    discount: 0,
    view: 'sell',
    sellCategory: 'all',
    sellSearch: '',
  };

  // ================= helpers =================
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (v) => Number(v) || 0;
  const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
  const usd = (n) => '$' + num(n).toFixed(2);
  const rate = () => num(state.settings.exchange_rate) || 1;
  const lbpRound = () => num(state.settings.lbp_round) || 1000;
  const toLbp = (u) => Math.round((num(u) * rate()) / lbpRound()) * lbpRound();
  const lbp = (n) => Math.round(num(n)).toLocaleString('en-US') + ' LBP';
  const isAdmin = () => state.user && state.user.role === 'admin';

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };

  async function api(path, opts = {}) {
    let res;
    try {
      res = await fetch('/api' + path, {
        method: opts.method || 'GET',
        headers: { 'Content-Type': 'application/json', ...(state.token ? { Authorization: 'Bearer ' + state.token } : {}) },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
    } catch { throw new Error('No internet connection. Check your Wi-Fi or data and try again.'); }
    let data = null;
    try { data = await res.json(); } catch {}
    if (res.status === 401 && path !== '/login') { signOutLocal(); throw new Error((data && data.error) || 'Please sign in again.'); }
    if (!res.ok) throw new Error((data && data.error) || 'Something went wrong.');
    return data;
  }

  let toastTimer;
  function toast(msg, isError = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast show' + (isError ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.className = 'toast'), isError ? 4200 : 2400);
  }

  // ---------- modal ----------
  function openModal(html, { wide = false, onOpen } = {}) {
    const root = $('#modal-root');
    root.innerHTML = `<div class="modal-backdrop"><div class="modal ${wide ? 'modal-wide' : ''}" role="dialog" aria-modal="true">${html}</div></div>`;
    const backdrop = root.firstElementChild;
    backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) closeModal(); });
    $$('[data-close]', root).forEach((b) => b.addEventListener('click', closeModal));
    const first = $('input:not([type=checkbox]), select, button.btn-primary', root);
    if (first) setTimeout(() => first.focus(), 30);
    if (onOpen) onOpen($('.modal', root));
    return $('.modal', root);
  }
  function closeModal() { $('#modal-root').innerHTML = ''; }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('#modal-root').innerHTML) closeModal(); });

  function confirmBox(message, okLabel = 'Confirm', danger = false) {
    return new Promise((resolve) => {
      const m = openModal(`
        <h2>${esc(message)}</h2>
        <div class="modal-foot">
          <button class="btn" data-no>Cancel</button>
          <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-yes>${esc(okLabel)}</button>
        </div>`);
      $('[data-no]', m).onclick = () => { closeModal(); resolve(false); };
      $('[data-yes]', m).onclick = () => { closeModal(); resolve(true); };
      setTimeout(() => $('[data-yes]', m).focus(), 150);
    });
  }

  // ================= auth =================
  function signOutLocal() {
    clearInterval(orderPoll);
    state.token = null; state.user = null;
    store.del('ots_token');
    showLogin();
  }

  const objSvg = (name) => window.objSvg(name);

  function showLogin() {
    document.body.classList.remove('in-app');
    $('#app-view').hidden = true;
    $('#login-view').hidden = false;
    $('#login-error').textContent = '';
    setTimeout(() => $('#login-form input[name=username]').focus(), 30);
  }

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const btn = $('button[type=submit]', e.target);
    btn.disabled = true;
    try {
      const data = await api('/login', { method: 'POST', body: { username: f.get('username'), password: f.get('password') } });
      state.token = data.token; state.user = data.user;
      store.set('ots_token', data.token);
      e.target.reset();
      await startApp();
    } catch (err) {
      $('#login-error').textContent = err.message;
    } finally { btn.disabled = false; }
  });

  $('#btn-logout').addEventListener('click', async () => {
    try { await api('/logout', { method: 'POST' }); } catch {}
    state.cart = []; state.discount = 0; saveCart();
    signOutLocal();
  });

  $('#btn-password').addEventListener('click', () => {
    const m = openModal(`
      <div class="modal-head"><h2>Change your password</h2><button class="btn btn-ghost btn-sm" data-close>Close</button></div>
      <form id="pw-form" class="grid-1" style="display:grid;gap:12px">
        <label>Current password<input name="current" type="password" required autocomplete="current-password"></label>
        <label>New password<input name="next" type="password" minlength="6" required autocomplete="new-password"></label>
        <p class="form-error" id="pw-error"></p>
        <div class="modal-foot"><button class="btn" type="button" data-close>Cancel</button><button class="btn btn-primary" type="submit">Save password</button></div>
      </form>`);
    $$('[data-close]', m).forEach((b) => (b.onclick = closeModal));
    $('#pw-form', m).onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      try {
        await api('/me/password', { method: 'PUT', body: { current: f.get('current'), next: f.get('next') } });
        closeModal(); toast('Password saved');
      } catch (err) { $('#pw-error', m).textContent = err.message; }
    };
  });

  // ================= app start =================
  const NAV = [
    { id: 'sell', label: 'Sell', all: true },
    { id: 'orders', label: 'Online orders', all: true },
    { id: 'sales', label: "Today's sales", all: true },
    { id: 'products', label: 'Products', all: true },
    { sep: true, admin: true },
    { id: 'printing', label: 'Printing prices', admin: true },
    { id: 'users', label: 'Staff', admin: true },
    { id: 'settings', label: 'Settings', admin: true },
  ];

  async function startApp() {
    document.body.classList.add('in-app');
    $('#login-view').hidden = true;
    $('#app-view').hidden = false;
    $('#me-name').textContent = state.user.name;
    $('#me-role').textContent = state.user.role === 'admin' ? 'Owner' : 'Cashier';
    renderNav();
    await refreshData();
    loadCart();
    go(state.view);
    startOrderPolling();
  }

  async function refreshData() {
    const [settings, products, categories, print] = await Promise.all([
      api('/settings'), api('/products'), api('/categories'), api('/print-prices'),
    ]);
    state.settings = settings;
    state.products = products;
    state.categories = categories;
    state.printPrices = print.prices;
    state.printExtras = print.extras;
    $('#shop-name').textContent = settings.shop_name || 'On the Spot';
    document.title = settings.shop_name || 'On the Spot';
    $('#rate-chip').innerHTML = `$1 = <strong>${num(settings.exchange_rate).toLocaleString('en-US')}</strong> LBP`;
  }

  function renderNav() {
    $('#nav').innerHTML = NAV.filter((n) => n.all || (n.admin && isAdmin()))
      .map((n) => (n.sep ? '<div class="nav-sep"></div>' : `<button type="button" data-view="${n.id}">${esc(n.label)}${n.id === 'orders' ? '<span class="nav-badge" id="orders-badge" hidden></span>' : ''}</button>`))
      .join('');
    $$('#nav button').forEach((b) => (b.onclick = () => go(b.dataset.view)));
  }

  // ---------- new online orders: badge + sound ----------
  let orderPoll = null, lastOrderId = null;
  function beep() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      [0, 0.18].forEach((t, i) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'sine'; o.frequency.value = i ? 1320 : 880;
        g.gain.setValueAtTime(0.0001, ctx.currentTime + t);
        g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + t + 0.28);
        o.connect(g).connect(ctx.destination); o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + 0.3);
      });
    } catch {}
  }
  async function checkOrders() {
    if (!state.token) return;
    try {
      const d = await api('/orders/new-count');
      const b = $('#orders-badge');
      if (b) { b.hidden = !d.n; b.textContent = d.n; }
      const last = Number(d.last_id);
      if (lastOrderId !== null && last > lastOrderId) {
        beep();
        toast('New online order');
        if (state.view === 'orders') renderOrders();
      }
      lastOrderId = Math.max(lastOrderId || 0, last);
    } catch {}
  }
  function startOrderPolling() {
    clearInterval(orderPoll);
    lastOrderId = null;
    checkOrders();
    orderPoll = setInterval(checkOrders, 20000);
  }

  function go(view) {
    const allowed = NAV.find((n) => n.id === view && (n.all || isAdmin()));
    state.view = allowed ? view : 'sell';
    $$('#nav button').forEach((b) => b.setAttribute('aria-current', b.dataset.view === state.view ? 'page' : 'false'));
    const views = { sell: renderSell, orders: renderOrders, sales: renderSales, products: renderProducts, printing: renderPrinting, users: renderUsers, settings: renderSettings };
    views[state.view]();
  }

  // ================= SELL =================
  function saveCart() { store.set('ots_cart', JSON.stringify({ cart: state.cart, discount: state.discount, order: state.pendingOrder || null })); }
  function loadCart() {
    try {
      const d = JSON.parse(store.get('ots_cart') || 'null');
      if (d && Array.isArray(d.cart)) { state.cart = d.cart; state.discount = num(d.discount); state.pendingOrder = d.order || null; }
    } catch {}
  }

  function printPrice(color, size, sided) {
    const p = state.printPrices.find((x) => x.color === color && x.size === size && x.sided === sided);
    return p ? num(p.price_per_page) : null;
  }
  function printLineTotal(item) {
    const per = printPrice(item.color, item.size, item.sided) ?? 0;
    let t = item.pages * item.copies * per;
    (item.extras || []).forEach((id) => {
      const ex = state.printExtras.find((e) => e.id === id);
      if (ex) t += num(ex.price) * item.copies;
    });
    return r2(t);
  }
  function lineTotal(item) { return item.type === 'product' ? r2(num(item.price) * item.qty) : printLineTotal(item); }
  function cartSubtotal() { return r2(state.cart.reduce((s, i) => s + lineTotal(i), 0)); }
  function cartTotal() { return r2(Math.max(0, cartSubtotal() - num(state.discount))); }

  function renderSell() {
    $('#view').innerHTML = `
      <div class="sell">
        <section class="catalog" aria-label="Products">
          <div class="search-row">
            <input id="sell-search" type="search" placeholder="Search a product or scan a barcode" value="${esc(state.sellSearch)}" autocomplete="off">
          </div>
          <div class="chips" id="sell-chips"></div>
          <div class="tiles" id="sell-tiles"></div>
        </section>
        <aside class="cart" aria-label="Cart">
          <div class="cart-head"><h2>Current sale</h2><button class="btn btn-ghost btn-sm" id="cart-clear" type="button">Clear</button></div>
          <div class="cart-lines" id="cart-lines"></div>
          <div class="cart-foot" id="cart-foot"></div>
        </aside>
      </div>`;

    const search = $('#sell-search');
    search.addEventListener('input', () => { state.sellSearch = search.value; renderTiles(); });
    search.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault(); // stop the scanner's Enter from also clicking the next button
      const code = search.value.trim();
      if (!code) return;
      const byCode = state.products.find((p) => p.barcode && p.barcode === code);
      const matches = filteredProducts();
      const pick = byCode || (matches.length === 1 ? matches[0] : null);
      if (pick) { addProduct(pick); search.value = ''; state.sellSearch = ''; renderTiles(); }
      else if (!matches.length) {
        // unknown barcode or name -> offer to add it as a new product
        const looksLikeBarcode = /^\d{4,}$/.test(code);
        confirmBox(`No product matches "${code}". Add it as a new product?`, 'Add product').then((yes) => {
          if (yes) editProduct(null, looksLikeBarcode ? { barcode: code } : { name: code });
        });
      }
    });
    $('#cart-clear').onclick = async () => {
      if (!state.cart.length) return;
      if (await confirmBox('Clear the whole sale?', 'Clear sale', true)) { state.cart = []; state.discount = 0; state.pendingOrder = null; saveCart(); renderCart(); }
    };
    renderChips(); renderTiles(); renderCart();
    search.focus();
  }

  // each category gets one of the printer inks: cyan, magenta, yellow, key
  function catInk(categoryId) {
    if (!categoryId) return 'k';
    const ids = state.categories.map((c) => c.id).sort((a, b) => a - b);
    const i = ids.indexOf(Number(categoryId));
    return i < 0 ? 'k' : ['c', 'm', 'y', 'k'][i % 4];
  }

  function renderChips() {
    const cats = [{ id: 'all', name: 'All' }, ...state.categories.filter((c) => c.product_count > 0)];
    $('#sell-chips').innerHTML = cats.map((c) => `<button type="button" class="chip" data-cat="${c.id}" aria-pressed="${String(state.sellCategory) === String(c.id)}">${c.id === 'all' ? '' : `<i class="ink-dot" data-ink="${catInk(c.id)}"></i>`}${esc(c.name)}</button>`).join('');
    $$('#sell-chips .chip').forEach((b) => (b.onclick = () => { state.sellCategory = b.dataset.cat; renderChips(); renderTiles(); }));
  }

  function filteredProducts() {
    const q = state.sellSearch.trim().toLowerCase();
    return state.products.filter((p) =>
      (state.sellCategory === 'all' || String(p.category_id) === String(state.sellCategory)) &&
      (!q || p.name.toLowerCase().includes(q) || (p.barcode || '').toLowerCase() === q));
  }

  function renderTiles() {
    const list = filteredProducts();
    const printTile = `<button type="button" class="tile tile-print" id="tile-print"><span class="t-name">Print job</span><span class="t-stock">Pages, copies, color, binding</span><span class="tile-obj" aria-hidden="true">${objSvg('sheet')}</span></button>`;
    const tiles = list.map((p) => {
      const inCart = state.cart.filter((i) => i.type === 'product' && i.product_id === p.id).reduce((s, i) => s + i.qty, 0);
      const left = p.stock_qty - inCart;
      const low = left <= p.min_stock;
      return `<button type="button" class="tile" data-id="${p.id}" data-ink="${catInk(p.category_id)}" ${left <= 0 ? 'disabled' : ''}>
        ${p.image_v ? `<img class="t-img" src="${productImg(p)}" alt="" loading="lazy">` : ''}
        <span class="t-name">${esc(p.name)}</span>
        <span class="t-foot"><span class="t-price num">${usd(p.sell_price)}</span><span class="t-stock ${low ? 'low' : ''}">${left <= 0 ? 'Out of stock' : left + ' left'}</span></span>
      </button>`;
    }).join('');
    const empty = !state.products.length
      ? `<div class="empty" style="grid-column:1/-1">${isAdmin() ? 'No products yet. Add them from <strong>Products</strong>.' : 'No products yet. Ask the owner to add them.'}</div>`
      : !list.length ? `<div class="empty" style="grid-column:1/-1">No products match your search.</div>` : '';
    $('#sell-tiles').innerHTML = printTile + tiles + empty;
    $('#tile-print').onclick = () => openPrintJob();
    $$('#sell-tiles .tile[data-id]').forEach((t) => (t.onclick = () => {
      const p = state.products.find((x) => x.id === Number(t.dataset.id));
      if (p) addProduct(p);
    }));
  }

  function addProduct(p) {
    const existing = state.cart.find((i) => i.type === 'product' && i.product_id === p.id);
    const inCart = existing ? existing.qty : 0;
    if (inCart + 1 > p.stock_qty) { toast(`Only ${p.stock_qty} "${p.name}" in stock`, true); return; }
    if (existing) existing.qty += 1;
    else state.cart.push({ key: 'p' + p.id, type: 'product', product_id: p.id, name: p.name, price: num(p.sell_price), qty: 1 });
    saveCart(); renderCart(); renderTiles();
  }

  function printDesc(it) {
    const c = it.color === 'bw' ? 'B&W' : 'Color';
    const s = it.sided === 'single' ? 'single-sided' : 'double-sided';
    return `${c} ${it.size}, ${s}`;
  }

  function renderCart() {
    const lines = $('#cart-lines');
    if (!lines) return;
    if (!state.cart.length) {
      lines.innerHTML = `<div class="cart-empty"><span class="tile-obj" aria-hidden="true">${objSvg('notebook')}</span><span>Tap a product or scan a barcode to start a sale.</span></div>`;
    } else {
      lines.innerHTML = state.cart.map((it, idx) => {
        if (it.type === 'product') {
          return `<div class="cart-line">
            <span class="cl-name">${esc(it.name)}</span>
            <span class="cl-total num">${usd(lineTotal(it))}</span>
            <span class="cl-sub num">${usd(it.price)} each</span>
            <span class="cl-actions">
              <button class="qty-btn" data-dec="${idx}" aria-label="One less">−</button>
              <span class="qty-val num">${it.qty}</span>
              <button class="qty-btn" data-inc="${idx}" aria-label="One more">+</button>
            </span>
          </div>`;
        }
        const extras = (it.extras || []).map((id) => (state.printExtras.find((e) => e.id === id) || {}).name).filter(Boolean);
        return `<div class="cart-line">
          <span class="cl-name">Print · ${it.pages} pg × ${it.copies}</span>
          <span class="cl-total num">${usd(lineTotal(it))}</span>
          <span class="cl-sub">${esc(printDesc(it))}${extras.length ? ' + ' + esc(extras.join(', ')) : ''}</span>
          <span class="cl-actions">
            <button class="btn btn-ghost btn-sm" data-edit="${idx}">Edit</button>
            <button class="qty-btn" data-del="${idx}" aria-label="Remove">×</button>
          </span>
        </div>`;
      }).join('');
    }
    $$('[data-inc]', lines).forEach((b) => (b.onclick = () => {
      const it = state.cart[b.dataset.inc];
      const p = state.products.find((x) => x.id === it.product_id);
      if (p && it.qty + 1 > p.stock_qty) return toast(`Only ${p.stock_qty} "${p.name}" in stock`, true);
      it.qty += 1; saveCart(); renderCart(); renderTiles();
    }));
    $$('[data-dec]', lines).forEach((b) => (b.onclick = () => {
      const i = Number(b.dataset.dec);
      state.cart[i].qty -= 1;
      if (state.cart[i].qty <= 0) state.cart.splice(i, 1);
      saveCart(); renderCart(); renderTiles();
    }));
    $$('[data-del]', lines).forEach((b) => (b.onclick = () => { state.cart.splice(Number(b.dataset.del), 1); saveCart(); renderCart(); }));
    $$('[data-edit]', lines).forEach((b) => (b.onclick = () => openPrintJob(Number(b.dataset.edit))));

    if (state.pendingOrder) {
      lines.insertAdjacentHTML('afterbegin', `<div class="cart-order" style="margin-top:10px"><span>Online order <strong>#${esc(state.pendingOrder.code)}</strong> · ${esc(state.pendingOrder.name)}</span><button class="qty-btn" id="cart-detach" aria-label="Unlink online order">×</button></div>`);
      $('#cart-detach').onclick = () => { state.pendingOrder = null; saveCart(); renderCart(); };
    }
    const sub = cartSubtotal();
    if (state.discount > sub) state.discount = sub;
    const total = cartTotal();
    $('#cart-foot').innerHTML = `
      <div class="sum-row"><span class="muted">Subtotal</span><span class="num">${usd(sub)}</span></div>
      <div class="sum-row"><label for="cart-discount" class="muted" style="font-size:15px;font-weight:400">Discount ($)</label>
        <input id="cart-discount" type="number" min="0" step="0.25" value="${state.discount || ''}" placeholder="0.00" inputmode="decimal"></div>
      <div class="sum-row"><span class="sum-total num">${usd(total)}</span><span class="sum-lbp num">${lbp(toLbp(total))}</span></div>
      <button class="btn btn-charge btn-block" id="btn-charge" ${state.cart.length ? '' : 'disabled'}>Charge ${usd(total)}</button>`;
    const d = $('#cart-discount');
    d.addEventListener('change', () => { state.discount = Math.max(0, num(d.value)); saveCart(); renderCart(); });
    $('#btn-charge').onclick = openPayment;
  }

  // ---------- print job dialog ----------
  function openPrintJob(editIndex = null) {
    const sizes = [...new Set(state.printPrices.map((p) => p.size))].sort((a, b) => (a === 'A4' ? -1 : b === 'A4' ? 1 : a.localeCompare(b)));
    if (!sizes.length) return toast(isAdmin() ? 'Set printing prices first (Printing prices page).' : 'No printing prices yet. Ask the owner to set them.', true);
    const base = editIndex !== null ? { ...state.cart[editIndex] } : { color: 'bw', size: sizes.includes('A4') ? 'A4' : sizes[0], sided: 'single', pages: 1, copies: 1, extras: [] };
    const job = { ...base, extras: [...(base.extras || [])] };

    const m = openModal(`
      <div class="modal-head"><h2>${editIndex !== null ? 'Edit print job' : 'Print job'}</h2><button class="btn btn-ghost btn-sm" data-close>Close</button></div>
      <div><div class="field-label">Color</div><div class="seg" data-seg="color">
        <button type="button" data-v="bw">Black &amp; white</button><button type="button" data-v="color">Color</button></div></div>
      <div class="grid-2">
        <div><div class="field-label">Paper size</div><div class="seg" data-seg="size">${sizes.map((s) => `<button type="button" data-v="${esc(s)}">${esc(s)}</button>`).join('')}</div></div>
        <div><div class="field-label">Sides</div><div class="seg" data-seg="sided"><button type="button" data-v="single">Single</button><button type="button" data-v="double">Double</button></div></div>
      </div>
      <div class="grid-2">
        <label>Pages per copy<input id="pj-pages" type="number" min="1" step="1" value="${job.pages}" inputmode="numeric"></label>
        <label>Copies<input id="pj-copies" type="number" min="1" step="1" value="${job.copies}" inputmode="numeric"></label>
      </div>
      ${state.printExtras.length ? `<div><div class="field-label">Extras (per copy)</div>${state.printExtras.map((e) => `
        <label class="check-row"><input type="checkbox" value="${e.id}" ${job.extras.includes(e.id) ? 'checked' : ''}><span>${esc(e.name)}</span><span class="num">${usd(e.price)}</span></label>`).join('')}</div>` : ''}
      <div class="price-preview"><span class="muted" id="pj-detail"></span><span class="big num" id="pj-total"></span></div>
      <div class="modal-foot"><button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="pj-add">${editIndex !== null ? 'Save changes' : 'Add to sale'}</button></div>`);

    function update() {
      $$('.seg', m).forEach((seg) => $$('button', seg).forEach((b) => b.setAttribute('aria-pressed', String(job[seg.dataset.seg] === b.dataset.v))));
      job.pages = Math.max(0, parseInt($('#pj-pages', m).value, 10) || 0);
      job.copies = Math.max(0, parseInt($('#pj-copies', m).value, 10) || 0);
      job.extras = $$('input[type=checkbox]:checked', m).map((c) => Number(c.value));
      const per = printPrice(job.color, job.size, job.sided);
      const ok = per !== null && job.pages > 0 && job.copies > 0;
      $('#pj-detail', m).textContent = per === null ? 'No price set for this option' : `${job.pages * job.copies} pages × $${per.toFixed(3).replace(/0$/, '')} per page`;
      $('#pj-total', m).textContent = usd(ok ? printLineTotal(job) : 0);
      $('#pj-add', m).disabled = !ok;
    }
    $$('.seg', m).forEach((seg) => $$('button', seg).forEach((b) => (b.onclick = () => { job[seg.dataset.seg] = b.dataset.v; update(); })));
    $$('input', m).forEach((i) => i.addEventListener('input', update));
    $('#pj-add', m).onclick = () => {
      const item = { key: 'print' + Date.now(), type: 'print', color: job.color, size: job.size, sided: job.sided, pages: job.pages, copies: job.copies, extras: job.extras };
      if (editIndex !== null) state.cart[editIndex] = item; else state.cart.push(item);
      saveCart(); closeModal(); renderCart();
    };
    update();
    setTimeout(() => { $('#pj-pages', m).focus(); $('#pj-pages', m).select(); }, 40);
  }

  // ---------- payment ----------
  function openPayment() {
    if (!state.cart.length) return;
    const total = cartTotal();
    const totalLbp = toLbp(total);
    const m = openModal(`
      <div class="modal-head"><h2>Take payment</h2><button class="btn btn-ghost btn-sm" data-close>Close</button></div>
      <div class="pay-total"><span class="big num">${usd(total)}</span><span class="sum-lbp num">${lbp(totalLbp)}</span></div>
      <div class="grid-2">
        <label>Paid in dollars ($)<input id="pay-usd" type="number" min="0" step="1" inputmode="decimal" placeholder="0"></label>
        <label>Paid in lira (LBP)<input id="pay-lbp" type="number" min="0" step="${lbpRound()}" inputmode="numeric" placeholder="0"></label>
      </div>
      <div class="quick">
        <button class="btn btn-sm" data-q="usd">Exact $</button>
        <button class="btn btn-sm" data-q="lbp">Exact LBP</button>
        ${[5, 10, 20, 50, 100].filter((v) => v >= total).slice(0, 3).map((v) => `<button class="btn btn-sm" data-q="u${v}">$${v}</button>`).join('')}
      </div>
      <div class="change-box" id="pay-change"></div>
      <p class="form-error" id="pay-error"></p>
      <div class="modal-foot"><button class="btn" data-close>Back</button><button class="btn btn-charge" id="pay-confirm" style="min-height:48px;font-size:17px">Complete sale</button></div>`);
    const pu = $('#pay-usd', m), pl = $('#pay-lbp', m);
    function update() {
      const paidEq = num(pu.value) * rate() + num(pl.value);
      const diff = paidEq - total * rate();
      const box = $('#pay-change', m);
      if (diff + lbpRound() / 2 < 0) {
        const left = Math.ceil(-diff / lbpRound()) * lbpRound();
        box.className = 'change-box short';
        box.innerHTML = `<span>Still to pay</span><span class="big num">${lbp(left)} <span style="font-size:15px">(${usd(left / rate())})</span></span>`;
        $('#pay-confirm', m).disabled = true;
      } else {
        const ch = Math.max(0, Math.round(diff / lbpRound()) * lbpRound());
        box.className = 'change-box';
        box.innerHTML = `<span>Change to give</span><span class="big num">${lbp(ch)}${ch ? ` <span style="font-size:15px">(${usd(ch / rate())})</span>` : ''}</span>`;
        $('#pay-confirm', m).disabled = false;
      }
    }
    pu.addEventListener('input', update); pl.addEventListener('input', update);
    $$('[data-q]', m).forEach((b) => (b.onclick = () => {
      const q = b.dataset.q;
      if (q === 'usd') { pu.value = total; pl.value = ''; }
      else if (q === 'lbp') { pl.value = totalLbp; pu.value = ''; }
      else { pu.value = q.slice(1); pl.value = ''; }
      update();
    }));
    pu.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !$('#pay-confirm', m).disabled) $('#pay-confirm', m).click(); });
    pl.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !$('#pay-confirm', m).disabled) $('#pay-confirm', m).click(); });
    $('#pay-confirm', m).onclick = async () => {
      const btn = $('#pay-confirm', m);
      btn.disabled = true;
      try {
        const items = state.cart.map((i) => i.type === 'product'
          ? { type: 'product', product_id: i.product_id, qty: i.qty }
          : { type: 'print', color: i.color, size: i.size, sided: i.sided, pages: i.pages, copies: i.copies, extras: i.extras });
        const sale = await api('/sales', { method: 'POST', body: { items, discount_usd: state.discount, paid_usd: num(pu.value), paid_lbp: num(pl.value) } });
        if (state.pendingOrder) {
          try { await api(`/orders/${state.pendingOrder.id}/complete`, { method: 'POST', body: { sale_id: sale.id } }); }
          catch (e) { toast('Sale saved, but the online order was not closed: ' + e.message, true); }
          state.pendingOrder = null;
        }
        state.cart = []; state.discount = 0; saveCart();
        state.products = await api('/products');
        renderSell();
        showReceipt(sale, true);
      } catch (err) {
        $('#pay-error', m).textContent = err.message;
        btn.disabled = false;
      }
    };
    update();
    setTimeout(() => pu.focus(), 40);
  }

  // ---------- receipt ----------
  function receiptHtml(sale) {
    const d = new Date(sale.created_at);
    const items = sale.items || [];
    const rateS = num(sale.exchange_rate);
    const round = lbpRound();
    const totLbp = Math.round((num(sale.total_usd) * rateS) / round) * round;
    return `<div class="receipt">
      <div class="r-center"><strong style="font-size:15px">${esc(state.settings.shop_name || 'On the Spot')}</strong><br>
      Receipt #${sale.id}<br>${d.toLocaleDateString('en-GB')} ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}<br>Cashier: ${esc(sale.cashier || '')}</div>
      <hr>
      ${items.map((i) => `<div>${esc(i.description)}</div><div class="r-row"><span>${i.item_type === 'product' ? `${i.qty} × ${usd(i.unit_price)}` : ''}</span><span>${usd(i.line_total)}</span></div>`).join('')}
      <hr>
      ${num(sale.discount_usd) ? `<div class="r-row"><span>Subtotal</span><span>${usd(sale.subtotal_usd)}</span></div><div class="r-row"><span>Discount</span><span>-${usd(sale.discount_usd)}</span></div>` : ''}
      <div class="r-row"><strong>TOTAL</strong><strong>${usd(sale.total_usd)}</strong></div>
      <div class="r-row"><span></span><span>${lbp(totLbp)}</span></div>
      <hr>
      ${num(sale.paid_usd) ? `<div class="r-row"><span>Paid $</span><span>${usd(sale.paid_usd)}</span></div>` : ''}
      ${num(sale.paid_lbp) ? `<div class="r-row"><span>Paid LBP</span><span>${lbp(sale.paid_lbp)}</span></div>` : ''}
      <div class="r-row"><span>Change</span><span>${lbp(sale.change_lbp)}</span></div>
      <div class="r-row"><span>Rate</span><span>${rateS.toLocaleString('en-US')}</span></div>
      ${sale.voided ? '<hr><div class="r-center"><strong>*** VOIDED ***</strong></div>' : ''}
      <hr><div class="r-center">${esc(state.settings.receipt_footer || '')}</div>
    </div>`;
  }

  function showReceipt(sale, justSold = false) {
    const m = openModal(`
      <div class="modal-head"><h2>${justSold ? 'Sale complete' : 'Receipt #' + sale.id}</h2><button class="btn btn-ghost btn-sm" data-close>Close</button></div>
      ${justSold ? `<div class="change-box"><span>Change to give</span><span class="big num">${lbp(sale.change_lbp)}</span></div>` : ''}
      ${receiptHtml(sale)}
      <div class="modal-foot"><button class="btn" id="rc-print">Print receipt</button><button class="btn btn-primary" data-close>${justSold ? 'New sale' : 'Done'}</button></div>`);
    $('#rc-print', m).onclick = () => printReceipt(sale);
    if (justSold) setTimeout(() => $('.btn-primary', m).focus(), 40);
  }

  function printReceipt(sale) {
    let area = $('#print-area');
    if (!area) { area = document.createElement('div'); area.id = 'print-area'; document.body.appendChild(area); }
    area.innerHTML = receiptHtml(sale);
    window.print();
  }

  // ================= TODAY'S SALES =================
  function localDate(d = new Date()) {
    const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
    return z.toISOString().slice(0, 10);
  }
  let salesDate = null;
  async function renderSales() {
    salesDate = salesDate || localDate();
    $('#view').innerHTML = `
      <div class="page-head">
        <div><h1>${isAdmin() ? 'Sales' : 'My sales'}</h1><p class="muted">${isAdmin() ? 'Every sale for the day. Tap a sale to see what was bought.' : 'Your sales for the day.'}</p></div>
        <div class="toolbar"><input type="date" id="sales-date" value="${salesDate}" ${isAdmin() ? '' : 'disabled'}></div>
      </div>
      <div class="stats" id="sales-stats"></div>
      <div class="panel"><div class="table-wrap" id="sales-table"><div class="empty">Loading…</div></div></div>`;
    $('#sales-date').onchange = (e) => { salesDate = e.target.value; renderSales(); };
    let sales;
    try { sales = await api('/sales' + (isAdmin() ? '?date=' + salesDate : '')); }
    catch (err) { $('#sales-table').innerHTML = `<div class="empty">${esc(err.message)}</div>`; return; }

    const live = sales.filter((s) => !s.voided);
    const total = live.reduce((s, x) => s + num(x.total_usd), 0);
    let printing = 0, products = 0;
    live.forEach((s) => (s.items || []).forEach((i) => { if (i.item_type === 'print') printing += num(i.line_total); else products += num(i.line_total); }));
    const discounts = live.reduce((s, x) => s + num(x.discount_usd), 0);
    $('#sales-stats').innerHTML = `
      <div class="stat"><span class="s-val num">${usd(total)}</span><span class="s-label">Total collected</span></div>
      <div class="stat"><span class="s-val num">${live.length}</span><span class="s-label">Sales</span></div>
      <div class="stat"><span class="s-val num">${usd(products)}</span><span class="s-label">From products</span></div>
      <div class="stat"><span class="s-val num">${usd(printing)}</span><span class="s-label">From printing</span></div>
      ${discounts ? `<div class="stat"><span class="s-val num">${usd(discounts)}</span><span class="s-label">Discounts given</span></div>` : ''}`;

    if (!sales.length) { $('#sales-table').innerHTML = `<div class="empty">No sales on this day yet.</div>`; return; }
    $('#sales-table').innerHTML = `<table>
      <thead><tr><th>#</th><th>Time</th>${isAdmin() ? '<th>Cashier</th>' : ''}<th>Items</th><th class="right">Total</th><th class="right">Paid</th><th></th></tr></thead>
      <tbody>${sales.map((s) => {
        const t = new Date(s.created_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
        const n = (s.items || []).length;
        const paid = [num(s.paid_usd) ? usd(s.paid_usd) : '', num(s.paid_lbp) ? lbp(s.paid_lbp) : ''].filter(Boolean).join(' + ');
        return `<tr class="sale-row ${s.voided ? 'voided' : ''}" data-id="${s.id}">
          <td class="num">${s.id}</td><td class="num">${t}</td>${isAdmin() ? `<td>${esc(s.cashier || '—')}</td>` : ''}
          <td>${n} item${n === 1 ? '' : 's'} ${s.voided ? '<span class="tag tag-low">Voided</span>' : ''}</td>
          <td class="right num"><strong>${usd(s.total_usd)}</strong></td><td class="right num muted">${paid}</td>
          <td class="right" style="white-space:nowrap">
            <button class="btn btn-sm" data-receipt="${s.id}">Receipt</button>
            ${isAdmin() && !s.voided ? `<button class="btn btn-sm btn-danger" data-void="${s.id}">Void</button>` : ''}
          </td></tr>
          <tr class="sale-items" data-items="${s.id}" hidden><td colspan="${isAdmin() ? 7 : 6}">
            ${(s.items || []).map((i) => `<div style="display:flex;justify-content:space-between;gap:12px"><span>${esc(i.description)}${i.item_type === 'product' ? ` × ${i.qty}` : ''}</span><span class="num">${usd(i.line_total)}</span></div>`).join('')}
            ${num(s.discount_usd) ? `<div style="display:flex;justify-content:space-between"><span>Discount</span><span class="num">-${usd(s.discount_usd)}</span></div>` : ''}
          </td></tr>`;
      }).join('')}</tbody></table>`;

    $$('.sale-row').forEach((r) => (r.onclick = (e) => {
      if (e.target.closest('button')) return;
      const row = $(`[data-items="${r.dataset.id}"]`);
      row.hidden = !row.hidden;
    }));
    $$('[data-receipt]').forEach((b) => (b.onclick = () => showReceipt(sales.find((s) => s.id === Number(b.dataset.receipt)))));
    $$('[data-void]').forEach((b) => (b.onclick = async () => {
      if (!(await confirmBox(`Void sale #${b.dataset.void}? Products go back to stock.`, 'Void sale', true))) return;
      try { await api(`/sales/${b.dataset.void}/void`, { method: 'POST' }); toast('Sale voided'); state.products = await api('/products'); renderSales(); }
      catch (err) { toast(err.message, true); }
    }));
  }

  // ================= PRODUCTS (owner) =================
  let prodFilter = { q: '', cat: 'all', low: false };
  function renderProducts() {
    $('#view').innerHTML = `
      <div class="page-head">
        <div><h1>Products</h1><p class="muted">${isAdmin() ? 'What you sell, its price and how many are on the shelf.' : 'Add new products here. Only the owner can change or delete them.'}</p></div>
        <div class="toolbar">${isAdmin() ? '<button class="btn" id="btn-cats">Categories</button>' : ''}<button class="btn btn-primary" id="btn-add-prod">Add product</button></div>
      </div>
      <div class="panel">
        <div class="panel-head"><div class="toolbar">
          <input type="search" id="pf-q" placeholder="Search products" value="${esc(prodFilter.q)}">
          <select id="pf-cat"><option value="all">All categories</option>${state.categories.map((c) => `<option value="${c.id}" ${String(prodFilter.cat) === String(c.id) ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
          <label class="check-row check-inline" style="padding:0"><input type="checkbox" id="pf-low" ${prodFilter.low ? 'checked' : ''}><span>Low stock only</span></label>
        </div><span class="muted" id="pf-count"></span></div>
        <div class="table-wrap" id="prod-table"></div>
      </div>`;
    $('#btn-add-prod').onclick = () => editProduct();
    if (isAdmin()) $('#btn-cats').onclick = manageCategories;
    $('#pf-q').oninput = (e) => { prodFilter.q = e.target.value; drawProductTable(); };
    $('#pf-cat').onchange = (e) => { prodFilter.cat = e.target.value; drawProductTable(); };
    $('#pf-low').onchange = (e) => { prodFilter.low = e.target.checked; drawProductTable(); };
    drawProductTable();
  }

  function drawProductTable() {
    const q = prodFilter.q.trim().toLowerCase();
    const list = state.products.filter((p) =>
      (!q || p.name.toLowerCase().includes(q) || (p.barcode || '').includes(q)) &&
      (prodFilter.cat === 'all' || String(p.category_id) === String(prodFilter.cat)) &&
      (!prodFilter.low || p.stock_qty <= p.min_stock));
    const lowCount = state.products.filter((p) => p.stock_qty <= p.min_stock).length;
    $('#pf-count').textContent = `${list.length} product${list.length === 1 ? '' : 's'}${lowCount ? ` · ${lowCount} low on stock` : ''}`;
    if (!state.products.length) {
      $('#prod-table').innerHTML = `<div class="empty">No products yet. Add your first one, for example "Copybook 100 pages".</div>`;
      return;
    }
    if (!list.length) { $('#prod-table').innerHTML = `<div class="empty">No products match these filters.</div>`; return; }
    const admin = isAdmin();
    $('#prod-table').innerHTML = `<table>
      <thead><tr><th>Name</th><th>Category</th><th>Barcode</th>${admin ? '<th class="right">Cost</th>' : ''}<th class="right">Price</th>${admin ? '<th class="right">Profit</th>' : ''}<th class="right">In stock</th>${admin ? '<th></th>' : ''}</tr></thead>
      <tbody>${list.map((p) => {
        const low = p.stock_qty <= p.min_stock;
        const noCost = admin && !num(p.cost_price);
        return `<tr>
          <td><span class="pt-name">${p.image_v ? `<img class="pt-thumb" src="${productImg(p)}" alt="" loading="lazy">` : '<span class="pt-thumb pt-none" aria-hidden="true"></span>'}<strong>${esc(p.name)}</strong></span></td>
          <td>${p.category_name ? `<span class="tag tag-grey">${esc(p.category_name)}</span>` : '<span class="muted">—</span>'}</td>
          <td class="num muted">${esc(p.barcode || '—')}</td>
          ${admin ? `<td class="right num">${noCost ? '<span class="tag tag-low">Not set</span>' : usd(p.cost_price)}</td>` : ''}
          <td class="right num"><strong>${usd(p.sell_price)}</strong></td>
          ${admin ? `<td class="right num muted">${noCost ? '—' : usd(num(p.sell_price) - num(p.cost_price))}</td>` : ''}
          <td class="right num"><span class="tag ${low ? 'tag-low' : 'tag-ok'}">${p.stock_qty}</span></td>
          ${admin ? `<td class="right" style="white-space:nowrap"><button class="btn btn-sm" data-stock="${p.id}">+ Stock</button> <button class="btn btn-sm" data-edit="${p.id}">Edit</button></td>` : ''}
        </tr>`;
      }).join('')}</tbody></table>`;
    $$('[data-edit]', $('#prod-table')).forEach((b) => (b.onclick = () => editProduct(state.products.find((p) => p.id === Number(b.dataset.edit)))));
    $$('[data-stock]', $('#prod-table')).forEach((b) => (b.onclick = () => addStock(state.products.find((p) => p.id === Number(b.dataset.stock)))));
  }

  // product photos
  const productImg = (p) => `/api/products/${p.id}/image?v=${p.image_v}`;
  async function shrinkImage(file, max = 800) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = url; });
      const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
      return await new Promise((ok, bad) => c.toBlob((b) => (b ? ok(b) : bad()), 'image/jpeg', 0.84));
    } finally { URL.revokeObjectURL(url); }
  }

  // after products change, refresh whichever screen is open
  function afterCatalogChange() {
    if (state.view === 'products') drawProductTable();
    else if (state.view === 'sell') { renderChips(); renderTiles(); }
  }

  function editProduct(p = null, prefill = {}) {
    const isNew = !p;
    if (!isNew && !isAdmin()) return;
    p = p || { name: '', category_id: '', barcode: '', cost_price: '', sell_price: '', stock_qty: '', min_stock: 5, image_v: 0, ...prefill };
    const canPhoto = isAdmin() || !p.image_v;
    let newPhoto = null;      // resized Blob waiting to upload
    let removePhoto = false;
    const m = openModal(`
      <div class="modal-head"><h2>${isNew ? 'Add product' : 'Edit product'}</h2><button class="btn btn-ghost btn-sm" data-close>Close</button></div>
      <form id="prod-form" style="display:grid;gap:12px">
        <div class="photo-row">
          <div class="photo-box" id="photo-box">${p.image_v ? `<img src="${productImg(p)}" alt="">` : '<span class="photo-empty" aria-hidden="true"></span>'}</div>
          <div class="photo-actions">
            <strong>Product photo</strong>
            <span class="muted" style="font-size:13px">${canPhoto ? 'Customers see it when they shop online.' : 'Only the owner can change this photo.'}</span>
            ${canPhoto ? `<div class="toolbar">
              <label class="btn btn-sm" style="cursor:pointer">${p.image_v ? 'Change photo' : 'Add photo'}<input type="file" id="photo-input" accept="image/*" hidden></label>
              <label class="btn btn-sm" style="cursor:pointer">Take photo<input type="file" id="photo-cam" accept="image/*" capture="environment" hidden></label>
              ${p.image_v && isAdmin() ? '<button class="btn btn-ghost btn-sm" type="button" id="photo-remove">Remove</button>' : ''}
            </div>` : ''}
          </div>
        </div>
        <label>Name<input name="name" value="${esc(p.name)}" required placeholder="Copybook 100 pages"></label>
        <div class="grid-2">
          <label>Category<select name="category_id"><option value="">No category</option>${state.categories.map((c) => `<option value="${c.id}" ${String(p.category_id) === String(c.id) ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
          <label>Barcode (optional)<input name="barcode" value="${esc(p.barcode || '')}" placeholder="Scan or type"></label>
        </div>
        <div class="grid-2">
          ${isAdmin() ? `<label>Cost price ($)<input name="cost_price" type="number" step="0.01" min="0" value="${p.cost_price}" inputmode="decimal" placeholder="What you pay"></label>` : ''}
          <label>Selling price ($)<input name="sell_price" type="number" step="0.01" min="0" value="${p.sell_price}" required inputmode="decimal"></label>
        </div>
        <div class="grid-2">
          <label>In stock<input name="stock_qty" type="number" step="1" min="0" value="${p.stock_qty}" inputmode="numeric" placeholder="0"></label>
          <label>Warn me when stock reaches<input name="min_stock" type="number" step="1" min="0" value="${p.min_stock}" inputmode="numeric"></label>
        </div>
        <p class="form-error" id="prod-error"></p>
        <div class="modal-foot" style="justify-content:space-between">
          ${isNew ? '<span></span>' : '<button class="btn btn-danger" type="button" id="prod-del">Delete product</button>'}
          <div style="display:flex;gap:10px"><button class="btn" type="button" data-close>Cancel</button><button class="btn btn-primary" type="submit">${isNew ? 'Add product' : 'Save changes'}</button></div>
        </div>
      </form>`);
    $$('[data-close]', m).forEach((b) => (b.onclick = closeModal));
    const onPick = async (input) => {
      const f = input.files && input.files[0];
      input.value = '';
      if (!f) return;
      try {
        newPhoto = await shrinkImage(f);
        removePhoto = false;
        $('#photo-box', m).innerHTML = `<img src="${URL.createObjectURL(newPhoto)}" alt="">`;
      } catch { toast("Couldn't read that photo. Try a JPG or PNG.", true); }
    };
    if ($('#photo-input', m)) $('#photo-input', m).onchange = (e) => onPick(e.target);
    if ($('#photo-cam', m)) $('#photo-cam', m).onchange = (e) => onPick(e.target);
    if ($('#photo-remove', m)) $('#photo-remove', m).onclick = () => { removePhoto = true; newPhoto = null; $('#photo-box', m).innerHTML = '<span class="photo-empty" aria-hidden="true"></span>'; };
    $('#prod-form', m).onsubmit = async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(e.target));
      const btn = $('button[type=submit]', e.target);
      btn.disabled = true;
      try {
        const saved = await api(isNew ? '/products' : '/products/' + p.id, { method: isNew ? 'POST' : 'PUT', body });
        if (newPhoto) {
          const res = await fetch(`/api/products/${saved.id}/image`, { method: 'PUT', headers: { 'Content-Type': newPhoto.type, Authorization: 'Bearer ' + state.token }, body: newPhoto });
          if (!res.ok) { let msg = 'The photo was not saved.'; try { msg = (await res.json()).error || msg; } catch {} toast('Product saved, but: ' + msg, true); }
        } else if (removePhoto) {
          await api(`/products/${saved.id}/image`, { method: 'DELETE' });
        }
        closeModal(); toast(isNew ? 'Product added' : 'Product saved');
        await reloadCatalog(); afterCatalogChange();
      } catch (err) { $('#prod-error', m).textContent = err.message; btn.disabled = false; }
    };
    if (!isNew) $('#prod-del', m).onclick = async () => {
      if (!(await confirmBox(`Delete "${p.name}"? Past sales keep their records.`, 'Delete product', true))) return;
      try { await api('/products/' + p.id, { method: 'DELETE' }); toast('Product deleted'); await reloadCatalog(); afterCatalogChange(); }
      catch (err) { toast(err.message, true); }
    };
  }

  function addStock(p) {
    const m = openModal(`
      <div class="modal-head"><h2>Add stock: ${esc(p.name)}</h2><button class="btn btn-ghost btn-sm" data-close>Close</button></div>
      <p class="muted" style="margin:0">Now in stock: <strong>${p.stock_qty}</strong></p>
      <label>How many arrived?<input id="st-qty" type="number" min="1" step="1" inputmode="numeric"></label>
      <p class="form-error" id="st-error"></p>
      <div class="modal-foot"><button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="st-save">Add to stock</button></div>`);
    const save = async () => {
      const add = parseInt($('#st-qty', m).value, 10);
      if (!(add > 0)) { $('#st-error', m).textContent = 'Enter a number of 1 or more.'; return; }
      try {
        await api('/products/' + p.id, { method: 'PUT', body: { ...p, stock_qty: p.stock_qty + add } });
        closeModal(); toast(`${add} added to "${p.name}"`); await reloadCatalog(); drawProductTable();
      } catch (err) { $('#st-error', m).textContent = err.message; }
    };
    $('#st-save', m).onclick = save;
    $('#st-qty', m).addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
  }

  function manageCategories() {
    const m = openModal(`
      <div class="modal-head"><h2>Categories</h2><button class="btn btn-ghost btn-sm" data-close>Close</button></div>
      <form id="cat-form" style="display:flex;gap:10px"><input name="name" placeholder="New category, e.g. Copybooks" required><button class="btn btn-primary" type="submit">Add</button></form>
      <div id="cat-list"></div>`);
    $$('[data-close]', m).forEach((b) => (b.onclick = () => { closeModal(); if (state.view === 'products') renderProducts(); }));
    const draw = () => {
      $('#cat-list', m).innerHTML = state.categories.length ? `<table><tbody>${state.categories.map((c) => `
        <tr><td><input value="${esc(c.name)}" data-cat-name="${c.id}"></td><td class="muted num" style="white-space:nowrap">${c.product_count} products</td>
        <td class="right" style="white-space:nowrap"><button class="btn btn-sm" data-cat-save="${c.id}">Save</button> <button class="btn btn-sm btn-danger" data-cat-del="${c.id}">Delete</button></td></tr>`).join('')}</tbody></table>`
        : '<div class="empty">No categories yet. Try Copybooks, Pens, Pencils, Notebooks.</div>';
      $$('[data-cat-save]', m).forEach((b) => (b.onclick = async () => {
        try { await api('/categories/' + b.dataset.catSave, { method: 'PUT', body: { name: $(`[data-cat-name="${b.dataset.catSave}"]`, m).value } }); toast('Category saved'); await reloadCatalog(); draw(); }
        catch (err) { toast(err.message, true); }
      }));
      $$('[data-cat-del]', m).forEach((b) => (b.onclick = async () => {
        try { await api('/categories/' + b.dataset.catDel, { method: 'DELETE' }); toast('Category deleted'); await reloadCatalog(); draw(); }
        catch (err) { toast(err.message, true); }
      }));
    };
    $('#cat-form', m).onsubmit = async (e) => {
      e.preventDefault();
      try { await api('/categories', { method: 'POST', body: { name: e.target.name.value } }); e.target.reset(); await reloadCatalog(); draw(); }
      catch (err) { toast(err.message, true); }
    };
    draw();
  }

  async function reloadCatalog() {
    const [products, categories] = await Promise.all([api('/products'), api('/categories')]);
    state.products = products; state.categories = categories;
  }

  // ================= PRINTING PRICES (owner) =================
  function renderPrinting() {
    const sizes = [...new Set(state.printPrices.map((p) => p.size))];
    const cols = [['bw', 'single', 'B&W single'], ['bw', 'double', 'B&W double'], ['color', 'single', 'Color single'], ['color', 'double', 'Color double']];
    const val = (size, color, sided) => { const p = state.printPrices.find((x) => x.size === size && x.color === color && x.sided === sided); return p ? num(p.price_per_page) : ''; };
    $('#view').innerHTML = `
      <div class="page-head"><div><h1>Printing prices</h1><p class="muted">Price per printed page, in dollars. The till multiplies by pages and copies.</p></div></div>
      <div class="panel">
        <div class="panel-head"><h2>Price per page</h2><div class="toolbar"><button class="btn" id="pp-add-size">Add paper size</button><button class="btn btn-primary" id="pp-save">Save prices</button></div></div>
        <div class="table-wrap price-grid"><table>
          <thead><tr><th>Paper size</th>${cols.map((c) => `<th class="right">${c[2]}</th>`).join('')}<th></th></tr></thead>
          <tbody>${sizes.map((s) => `<tr><td><strong>${esc(s)}</strong></td>${cols.map((c) => `<td><input type="number" step="0.001" min="0" data-size="${esc(s)}" data-color="${c[0]}" data-sided="${c[1]}" value="${val(s, c[0], c[1])}" inputmode="decimal"></td>`).join('')}
            <td class="right"><button class="btn btn-sm btn-danger" data-del-size="${esc(s)}">Remove</button></td></tr>`).join('') || `<tr><td colspan="6" class="empty">No paper sizes yet.</td></tr>`}</tbody>
        </table></div>
      </div>
      <div class="panel">
        <div class="panel-head"><div><h2>Extras</h2><p class="muted" style="margin:2px 0 0">Charged once per copy, like binding or lamination.</p></div></div>
        <form id="ex-form" class="toolbar" style="margin-bottom:12px"><input name="name" placeholder="e.g. Stapling" required><input name="price" type="number" min="0" step="0.05" placeholder="Price $" required style="min-width:110px;width:120px"><button class="btn btn-primary" type="submit">Add extra</button></form>
        <div class="table-wrap"><table><tbody>${state.printExtras.map((e) => `<tr>
          <td><input value="${esc(e.name)}" data-ex-name="${e.id}"></td>
          <td style="width:140px"><input type="number" min="0" step="0.05" value="${num(e.price)}" data-ex-price="${e.id}"></td>
          <td class="right" style="white-space:nowrap"><button class="btn btn-sm" data-ex-save="${e.id}">Save</button> <button class="btn btn-sm btn-danger" data-ex-del="${e.id}">Delete</button></td></tr>`).join('') || '<tr><td class="empty">No extras yet.</td></tr>'}</tbody></table></div>
      </div>`;

    $('#pp-save').onclick = async () => {
      const list = $$('.price-grid input').filter((i) => i.value !== '').map((i) => ({ size: i.dataset.size, color: i.dataset.color, sided: i.dataset.sided, price_per_page: num(i.value) }));
      try { await api('/print-prices', { method: 'PUT', body: list }); await reloadPrint(); toast('Printing prices saved'); renderPrinting(); }
      catch (err) { toast(err.message, true); }
    };
    $('#pp-add-size').onclick = () => {
      const m = openModal(`
        <div class="modal-head"><h2>Add paper size</h2><button class="btn btn-ghost btn-sm" data-close>Close</button></div>
        <label>Size name<input id="ns-name" placeholder="e.g. A5"></label>
        <div class="modal-foot"><button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="ns-add">Add size</button></div>`);
      $('#ns-add', m).onclick = async () => {
        const size = $('#ns-name', m).value.trim().toUpperCase();
        if (!size) return;
        const list = cols.map((c) => ({ size, color: c[0], sided: c[1], price_per_page: 0 }));
        try { await api('/print-prices', { method: 'PUT', body: list }); await reloadPrint(); closeModal(); renderPrinting(); toast(`${size} added. Now set its prices.`); }
        catch (err) { toast(err.message, true); }
      };
    };
    $$('[data-del-size]').forEach((b) => (b.onclick = async () => {
      if (!(await confirmBox(`Remove ${b.dataset.delSize} printing?`, 'Remove size', true))) return;
      try { await api('/print-prices/size/' + encodeURIComponent(b.dataset.delSize), { method: 'DELETE' }); await reloadPrint(); renderPrinting(); }
      catch (err) { toast(err.message, true); }
    }));
    $('#ex-form').onsubmit = async (e) => {
      e.preventDefault();
      try { await api('/print-extras', { method: 'POST', body: { name: e.target.name.value, price: e.target.price.value } }); await reloadPrint(); renderPrinting(); toast('Extra added'); }
      catch (err) { toast(err.message, true); }
    };
    $$('[data-ex-save]').forEach((b) => (b.onclick = async () => {
      const id = b.dataset.exSave;
      try { await api('/print-extras/' + id, { method: 'PUT', body: { name: $(`[data-ex-name="${id}"]`).value, price: $(`[data-ex-price="${id}"]`).value } }); await reloadPrint(); toast('Extra saved'); }
      catch (err) { toast(err.message, true); }
    }));
    $$('[data-ex-del]').forEach((b) => (b.onclick = async () => {
      try { await api('/print-extras/' + b.dataset.exDel, { method: 'DELETE' }); await reloadPrint(); renderPrinting(); toast('Extra deleted'); }
      catch (err) { toast(err.message, true); }
    }));
  }
  async function reloadPrint() { const d = await api('/print-prices'); state.printPrices = d.prices; state.printExtras = d.extras; }

  // ================= STAFF (owner) =================
  async function renderUsers() {
    $('#view').innerHTML = `
      <div class="page-head"><div><h1>Staff</h1><p class="muted">Who can open the till. Cashiers can sell but can't change prices or see cost prices.</p></div>
        <button class="btn btn-primary" id="u-add">Add staff member</button></div>
      <div class="panel"><div class="table-wrap" id="u-table"><div class="empty">Loading…</div></div></div>`;
    $('#u-add').onclick = () => editUser();
    let users;
    try { users = await api('/users'); } catch (err) { $('#u-table').innerHTML = `<div class="empty">${esc(err.message)}</div>`; return; }
    $('#u-table').innerHTML = `<table><thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody>
      ${users.map((u) => `<tr><td><strong>${esc(u.name)}</strong>${u.id === state.user.id ? ' <span class="muted">(you)</span>' : ''}</td><td>${esc(u.username)}</td>
        <td><span class="tag ${u.role === 'admin' ? '' : 'tag-grey'}">${u.role === 'admin' ? 'Owner' : 'Cashier'}</span></td>
        <td><span class="tag ${u.active ? 'tag-ok' : 'tag-low'}">${u.active ? 'Active' : 'Blocked'}</span></td>
        <td class="right"><button class="btn btn-sm" data-u="${u.id}">Edit</button></td></tr>`).join('')}</tbody></table>`;
    $$('[data-u]').forEach((b) => (b.onclick = () => editUser(users.find((u) => u.id === Number(b.dataset.u)))));
  }

  function editUser(u = null) {
    const isNew = !u;
    u = u || { name: '', username: '', role: 'cashier', active: true };
    const self = !isNew && u.id === state.user.id;
    const m = openModal(`
      <div class="modal-head"><h2>${isNew ? 'Add staff member' : 'Edit ' + esc(u.name)}</h2><button class="btn btn-ghost btn-sm" data-close>Close</button></div>
      <form id="u-form" style="display:grid;gap:12px">
        <div class="grid-2"><label>Name<input name="name" value="${esc(u.name)}" required></label><label>Username<input name="username" value="${esc(u.username)}" required autocomplete="off"></label></div>
        <label>${isNew ? 'Password' : 'New password (leave empty to keep)'}<input name="password" type="password" minlength="6" ${isNew ? 'required' : ''} autocomplete="new-password"></label>
        <div class="grid-2">
          <label>Role<select name="role" ${self ? 'disabled' : ''}><option value="cashier" ${u.role === 'cashier' ? 'selected' : ''}>Cashier</option><option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Owner</option></select></label>
          ${isNew ? '' : `<label>Status<select name="active" ${self ? 'disabled' : ''}><option value="true" ${u.active ? 'selected' : ''}>Active</option><option value="false" ${!u.active ? 'selected' : ''}>Blocked</option></select></label>`}
        </div>
        <p class="form-error" id="u-error"></p>
        <div class="modal-foot"><button class="btn" type="button" data-close>Cancel</button><button class="btn btn-primary" type="submit">${isNew ? 'Add staff member' : 'Save changes'}</button></div>
      </form>`);
    $$('[data-close]', m).forEach((b) => (b.onclick = closeModal));
    $('#u-form', m).onsubmit = async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      const body = { name: f.name, username: f.username, password: f.password || undefined };
      if (!self) { body.role = f.role; if (!isNew) body.active = f.active === 'true'; }
      try {
        await api(isNew ? '/users' : '/users/' + u.id, { method: isNew ? 'POST' : 'PUT', body });
        closeModal(); toast(isNew ? 'Staff member added' : 'Saved'); renderUsers();
      } catch (err) { $('#u-error', m).textContent = err.message; }
    };
  }

  // ================= SETTINGS (owner) =================
  function renderSettings() {
    const s = state.settings;
    const link = location.origin + '/order';
    $('#view').innerHTML = `
      <div class="page-head"><div><h1>Settings</h1><p class="muted">Shop details, the dollar rate, and online orders.</p></div></div>
      <form id="set-form" style="display:grid;gap:16px;max-width:760px">
        <div class="panel" style="display:grid;gap:14px">
          <h2>Shop</h2>
          <label>Shop name<input name="shop_name" value="${esc(s.shop_name)}" required></label>
          <div class="grid-2">
            <label>Dollar rate (LBP for $1)<input name="exchange_rate" type="number" min="1" step="1" value="${esc(s.exchange_rate)}" required inputmode="numeric"></label>
            <label>Round LBP to nearest<select name="lbp_round">${[1, 500, 1000, 5000, 10000].map((v) => `<option value="${v}" ${num(s.lbp_round) === v ? 'selected' : ''}>${v.toLocaleString('en-US')} LBP</option>`).join('')}</select></label>
          </div>
          <label>Receipt footer<input name="receipt_footer" value="${esc(s.receipt_footer)}"></label>
        </div>
        <div class="panel" style="display:grid;gap:14px">
          <h2>Online orders</h2>
          <div class="grid-2">
            <label>Customers can order online<select name="online_orders"><option value="on" ${s.online_orders !== 'off' ? 'selected' : ''}>On</option><option value="off" ${s.online_orders === 'off' ? 'selected' : ''}>Paused</option></select></label>
            <label>Shop WhatsApp number<input name="whatsapp_number" value="${esc(s.whatsapp_number || '')}" placeholder="03 123 456" inputmode="tel"></label>
          </div>
          <div class="grid-2">
            <label>Opening hours<input name="shop_hours" value="${esc(s.shop_hours || '')}" placeholder="Mon–Sat, 8 am – 7 pm"></label>
            <label>Address<input name="shop_address" value="${esc(s.shop_address || '')}" placeholder="Street, town"></label>
          </div>
          <div class="share-box">
            <div style="display:grid;gap:10px">
              <span class="field-label" style="margin:0">Customer page link</span>
              <div class="link-row"><input id="cust-link" value="${esc(link)}" readonly><button class="btn" type="button" id="copy-link">Copy</button></div>
              <div class="toolbar"><a class="btn btn-sm" href="/order" target="_blank" rel="noopener" style="text-decoration:none">Open customer page</a><button class="btn btn-sm" type="button" id="qr-download">Download QR code</button></div>
              <p class="muted" style="margin:0;font-size:13px">Print the QR code and put it on the counter, or share the link on Instagram and WhatsApp.</p>
            </div>
            <div class="qr" id="qr"><span class="muted" style="color:#555;font-size:12px">Loading QR…</span></div>
          </div>
        </div>
        <p class="form-error" id="set-error"></p>
        <div><button class="btn btn-primary" type="submit">Save settings</button></div>
      </form>`;
    $('#set-form').onsubmit = async (e) => {
      e.preventDefault();
      try {
        state.settings = await api('/settings', { method: 'PUT', body: Object.fromEntries(new FormData(e.target)) });
        await refreshData(); toast('Settings saved');
      } catch (err) { $('#set-error').textContent = err.message; }
    };
    $('#copy-link').onclick = async () => {
      try { await navigator.clipboard.writeText(link); toast('Link copied'); }
      catch { $('#cust-link').select(); toast('Select the link and copy it'); }
    };
    loadQr().then((QR) => {
      const box = $('#qr');
      if (!box) return;
      if (!QR) { box.innerHTML = '<span style="color:#555;font-size:12px;text-align:center">QR code needs an internet connection</span>'; return; }
      box.innerHTML = '';
      new QR(box, { text: link, width: 264, height: 264, colorDark: '#0D0820', colorLight: '#ffffff', correctLevel: QR.CorrectLevel.M });
    });
    $('#qr-download').onclick = () => {
      const c = $('#qr canvas'), img = $('#qr img');
      const src = (c && c.toDataURL('image/png')) || (img && img.src);
      if (!src) return toast('QR code is not ready yet', true);
      const a = document.createElement('a'); a.href = src; a.download = 'on-the-spot-order-qr.png'; a.click();
    };
  }

  let qrPromise = null;
  function loadQr() {
    if (window.QRCode) return Promise.resolve(window.QRCode);
    if (qrPromise) return qrPromise;
    qrPromise = new Promise((resolve) => {
      const sc = document.createElement('script');
      sc.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
      const t = setTimeout(() => resolve(null), 7000);
      sc.onload = () => { clearTimeout(t); resolve(window.QRCode || null); };
      sc.onerror = () => { clearTimeout(t); qrPromise = null; resolve(null); };
      document.head.appendChild(sc);
    });
    return qrPromise;
  }

  // ================= ONLINE ORDERS =================
  let ordersTab = 'active';
  const ORDER_LABEL = { received: 'New', preparing: 'Preparing', ready: 'Ready', picked_up: 'Picked up', cancelled: 'Cancelled' };
  function waLink(raw, text = '') {
    let d = String(raw || '').replace(/\D/g, '');
    if (!d) return '';
    if (d.startsWith('00')) d = d.slice(2);
    if (!d.startsWith('961')) d = '961' + d.replace(/^0/, '');
    return 'https://wa.me/' + d + (text ? '?text=' + encodeURIComponent(text) : '');
  }
  function timeAgo(iso) {
    const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    if (m < 60 * 24) return Math.round(m / 60) + ' h ago';
    return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }
  const fmtBytes = (b) => (b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');

  async function renderOrders() {
    $('#view').innerHTML = `
      <div class="page-head">
        <div><h1>Online orders</h1><p class="muted">Orders customers send from the website. They pay when they pick up.</p></div>
        <div class="ord-tabs">
          <button class="chip" data-otab="active" aria-pressed="${ordersTab === 'active'}">Open orders</button>
          <button class="chip" data-otab="done" aria-pressed="${ordersTab === 'done'}">Finished</button>
          <button class="btn btn-sm" id="ord-refresh">Refresh</button>
        </div>
      </div>
      <div id="ord-body"><div class="empty">Loading…</div></div>`;
    $$('[data-otab]').forEach((b) => (b.onclick = () => { ordersTab = b.dataset.otab; renderOrders(); }));
    $('#ord-refresh').onclick = () => { renderOrders(); checkOrders(); };
    let list;
    try { list = await api('/orders' + (ordersTab === 'done' ? '?view=done' : '')); }
    catch (err) { $('#ord-body').innerHTML = `<div class="empty">${esc(err.message)}</div>`; return; }
    if (state.view !== 'orders') return;

    if (ordersTab === 'done') {
      $('#ord-body').innerHTML = list.length ? `<div class="ord-stack" style="max-width:760px">${list.map(orderCard).join('')}</div>` : `<div class="ord-empty">No finished orders yet.</div>`;
    } else {
      const col = (st, title, empty) => {
        const items = list.filter((o) => o.status === st);
        return `<section class="ord-col"><h3>${title} <span class="tag ${st === 'received' ? 'tag-low' : st === 'ready' ? 'tag-ok' : ''}">${items.length}</span></h3>
          <div class="ord-stack">${items.length ? items.map(orderCard).join('') : `<div class="ord-empty">${empty}</div>`}</div></section>`;
      };
      $('#ord-body').innerHTML = `<div class="ord-cols">
        ${col('received', 'New', 'No new orders. Share your order link to get some!')}
        ${col('preparing', 'Preparing', 'Nothing in progress.')}
        ${col('ready', 'Ready for pickup', 'Nothing waiting for pickup.')}
      </div>`;
    }
    bindOrderCards(list);
  }

  function orderCard(o) {
    const items = o.items || [];
    const extrasNames = (ids) => { try { return JSON.parse(ids || '[]').map((id) => (state.printExtras.find((e) => e.id === id) || {}).name).filter(Boolean); } catch { return []; } };
    const actions = {
      received: `<button class="btn btn-primary btn-sm" data-ost="preparing" data-oid="${o.id}">Start preparing</button><button class="btn btn-sm" data-ost="ready" data-oid="${o.id}">Mark ready</button>`,
      preparing: `<button class="btn btn-primary btn-sm" data-ost="ready" data-oid="${o.id}">Mark ready</button>`,
      ready: `<button class="btn btn-primary btn-sm" data-till="${o.id}">Load into till</button><a class="btn btn-sm" style="text-decoration:none" target="_blank" rel="noopener" href="${waLink(o.phone, `Hi ${o.customer_name}, your order #${o.code} is ready at ${state.settings.shop_name || 'On the Spot'}. Total: ${usd(o.total_usd)}.`)}">Remind on WhatsApp</a>`,
    }[o.status] || '';
    return `<article class="ord-card ${o.status === 'received' ? 'is-new' : ''}">
      <div class="ord-top">
        <div><div class="ord-code">#${esc(o.code)}</div><span class="muted" style="font-size:13px">${timeAgo(o.created_at)}</span></div>
        <span class="tag ${o.status === 'cancelled' ? 'tag-low' : o.status === 'picked_up' || o.status === 'ready' ? 'tag-ok' : ''}">${ORDER_LABEL[o.status]}</span>
      </div>
      <div class="ord-who"><strong>${esc(o.customer_name)}</strong><a href="${waLink(o.phone)}" target="_blank" rel="noopener">${esc(o.phone)} · WhatsApp</a></div>
      <div class="ord-items">${items.map((i) => i.item_type === 'print' ? `
        <div class="ord-item"><strong>Print · ${i.pages} pg × ${i.copies}</strong><span class="num">${usd(i.line_total)}</span>
          <span class="muted" style="grid-column:1/-1">${esc(i.file_name || 'File')} · ${i.color === 'bw' ? 'B&W' : 'Color'} ${esc(i.size)}, ${i.sided === 'single' ? 'single' : 'double'}-sided${extrasNames(i.extras).length ? ' + ' + esc(extrasNames(i.extras).join(', ')) : ''}</span>
          ${i.file_id && i.file_ok ? `<button class="btn btn-sm" data-file="${i.file_id}" data-forder="${o.id}" data-fname="${esc(i.file_name)}">Download file${i.file_size ? ' · ' + fmtBytes(i.file_size) : ''}</button>` : i.file_id ? '<span class="muted" style="grid-column:1/-1">File removed after 7 days</span>' : ''}
        </div>` : `
        <div class="ord-item"><strong>${esc(i.description)} × ${i.qty}</strong><span class="num">${usd(i.line_total)}</span></div>`).join('')}</div>
      ${o.note ? `<div class="ord-note">${esc(o.note)}</div>` : ''}
      <div class="ord-total"><span class="muted">To pay at pickup</span><strong class="num">${usd(o.total_usd)}</strong></div>
      ${['received', 'preparing', 'ready'].includes(o.status) ? `<div class="ord-actions">${actions}<button class="btn btn-ghost btn-sm" data-ost="cancelled" data-oid="${o.id}">Cancel</button></div>` : ''}
      ${o.status === 'cancelled' && isAdmin() ? `<div class="ord-actions"><button class="btn btn-sm" data-ost="received" data-oid="${o.id}">Reopen</button></div>` : ''}
    </article>`;
  }

  function bindOrderCards(list) {
    $$('[data-ost]').forEach((b) => (b.onclick = async () => {
      const id = Number(b.dataset.oid), st = b.dataset.ost;
      const o = list.find((x) => x.id === id);
      if (st === 'cancelled' && !(await confirmBox(`Cancel order #${o.code}?`, 'Cancel order', true))) return;
      try {
        await api(`/orders/${id}/status`, { method: 'PUT', body: { status: st } });
        toast(st === 'ready' ? `#${o.code} is ready` : st === 'preparing' ? `Preparing #${o.code}` : st === 'cancelled' ? `#${o.code} cancelled` : 'Order updated');
        checkOrders();
        if (st === 'ready') tellReady(o);
        renderOrders();
      } catch (err) { toast(err.message, true); }
    }));
    $$('[data-file]').forEach((b) => (b.onclick = async () => {
      b.disabled = true;
      try {
        const res = await fetch(`/api/orders/${b.dataset.forder}/files/${b.dataset.file}`, { headers: { Authorization: 'Bearer ' + state.token } });
        if (!res.ok) { let m = 'Could not download the file.'; try { m = (await res.json()).error || m; } catch {} throw new Error(m); }
        const blob = await res.blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob); a.download = b.dataset.fname || 'file';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      } catch (err) { toast(err.message, true); }
      b.disabled = false;
    }));
    $$('[data-till]').forEach((b) => (b.onclick = () => loadOrderIntoTill(list.find((x) => x.id === Number(b.dataset.till)))));
  }

  function tellReady(o) {
    const text = `Hi ${o.customer_name}, your order #${o.code} is ready at ${state.settings.shop_name || 'On the Spot'}. Total: ${usd(o.total_usd)}. See you soon!`;
    const m = openModal(`
      <div class="modal-head"><h2>Tell ${esc(o.customer_name)} it's ready?</h2><button class="btn btn-ghost btn-sm" data-close>Close</button></div>
      <p class="muted" style="margin:0">Their order page already shows "Ready for pickup". You can also send a WhatsApp message:</p>
      <div class="ord-note">${esc(text)}</div>
      <div class="modal-foot"><button class="btn" data-close>Not now</button><a class="btn btn-primary" style="text-decoration:none" target="_blank" rel="noopener" href="${waLink(o.phone, text)}" id="wa-send">Send on WhatsApp</a></div>`);
    $('#wa-send', m).addEventListener('click', () => setTimeout(closeModal, 300));
  }

  async function loadOrderIntoTill(o) {
    if (state.cart.length && !(await confirmBox('The till already has items. Replace them with this order?', 'Replace', true))) return;
    const cart = [];
    const missing = [];
    for (const i of o.items || []) {
      if (i.item_type === 'print') {
        let extras = [];
        try { extras = JSON.parse(i.extras || '[]').map(Number); } catch {}
        cart.push({ key: 'print' + i.id, type: 'print', color: i.color, size: i.size, sided: i.sided, pages: i.pages, copies: i.copies, extras });
      } else {
        const p = state.products.find((x) => x.id === i.product_id);
        if (!p) { missing.push(i.description); continue; }
        cart.push({ key: 'p' + p.id, type: 'product', product_id: p.id, name: p.name, price: num(p.sell_price), qty: i.qty });
      }
    }
    state.cart = cart;
    state.discount = 0;
    state.pendingOrder = { id: o.id, code: o.code, name: o.customer_name };
    saveCart();
    go('sell');
    if (missing.length) toast('Not in the product list anymore: ' + missing.join(', '), true);
    else toast(`Order #${o.code} is in the till. Take the payment.`);
  }

  // ================= install as app =================
  if (window.otsInstall) {
    const help = () => openModal(window.otsInstall.iosHelpHtml('the till app'));
    window.otsInstall.onChange(() => {
      const ok = window.otsInstall.available();
      $('#install-login').hidden = !ok; $('#install-side').hidden = !ok;
    });
    $('#install-login').onclick = () => window.otsInstall.prompt(help);
    $('#install-side').onclick = () => window.otsInstall.prompt(help);
  }

  // ================= boot =================
  (async function boot() {
    const token = store.get('ots_token');
    if (!token) return showLogin();
    state.token = token;
    try {
      const { user } = await api('/me');
      state.user = user;
      await startApp();
    } catch { showLogin(); }
  })();
})();
