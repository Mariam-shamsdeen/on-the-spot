// On the Spot — POS server
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { pool, init, hashPassword, checkPassword } = require('./db');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const SESSION_DAYS = 14;
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// wrap async route handlers so errors become JSON responses
const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => {
    if (err.status) return res.status(err.status).json({ error: err.message });
    if (err.code === '23505') return res.status(400).json({ error: 'This value already exists (name, username or barcode must be unique).' });
    console.error(err);
    res.status(500).json({ error: 'Server error. Please try again.' });
  });
const fail = (status, message) => Object.assign(new Error(message), { status });

async function getSettings() {
  const { rows } = await pool.query('SELECT key, value FROM settings');
  const s = {};
  rows.forEach((r) => (s[r.key] = r.value));
  return s;
}

// ---------------- auth ----------------
async function auth(req, res, next) {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Please log in.' });
    const { rows } = await pool.query(
      `SELECT u.id, u.name, u.username, u.role FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token = $1 AND s.expires_at > NOW() AND u.active = TRUE`,
      [token]
    );
    if (!rows.length) return res.status(401).json({ error: 'Session expired. Please log in again.' });
    req.user = rows[0];
    req.token = token;
    next();
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error.' });
  }
}
function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only the owner can do this.' });
  next();
}

app.post('/api/login', wrap(async (req, res) => {
  const { username, password } = req.body || {};
  const { rows } = await pool.query('SELECT * FROM users WHERE LOWER(username) = LOWER($1) AND active = TRUE', [String(username || '').trim()]);
  const u = rows[0];
  if (!u || !checkPassword(String(password || ''), u.password_hash)) throw fail(401, 'Wrong username or password.');
  const token = crypto.randomBytes(32).toString('hex');
  await pool.query(`INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, NOW() + INTERVAL '${SESSION_DAYS} days')`, [token, u.id]);
  await pool.query('DELETE FROM sessions WHERE expires_at < NOW()');
  res.json({ token, user: { id: u.id, name: u.name, username: u.username, role: u.role } });
}));

app.post('/api/logout', auth, wrap(async (req, res) => {
  await pool.query('DELETE FROM sessions WHERE token = $1', [req.token]);
  res.json({ ok: true });
}));

app.get('/api/me', auth, (req, res) => res.json({ user: req.user }));

app.put('/api/me/password', auth, wrap(async (req, res) => {
  const { current, next: newPass } = req.body || {};
  if (!newPass || String(newPass).length < 6) throw fail(400, 'New password must be at least 6 characters.');
  const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  if (!checkPassword(String(current || ''), rows[0].password_hash)) throw fail(400, 'Current password is wrong.');
  await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hashPassword(String(newPass)), req.user.id]);
  res.json({ ok: true });
}));

// ---------------- settings ----------------
app.get('/api/settings', auth, wrap(async (req, res) => res.json(await getSettings())));

app.put('/api/settings', auth, adminOnly, wrap(async (req, res) => {
  const allowed = ['shop_name', 'exchange_rate', 'lbp_round', 'receipt_footer', 'online_orders', 'whatsapp_number', 'shop_hours', 'shop_address'];
  const body = req.body || {};
  if (body.online_orders !== undefined && !['on', 'off'].includes(body.online_orders)) throw fail(400, 'Online orders must be on or off.');
  if (body.exchange_rate !== undefined && !(Number(body.exchange_rate) > 0)) throw fail(400, 'Exchange rate must be a positive number.');
  if (body.lbp_round !== undefined && !(Number(body.lbp_round) >= 1)) throw fail(400, 'LBP rounding must be 1 or more.');
  for (const k of allowed) {
    if (body[k] !== undefined) {
      await pool.query('INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [k, String(body[k]).trim()]);
    }
  }
  res.json(await getSettings());
}));

// ---------------- users (owner only) ----------------
app.get('/api/users', auth, adminOnly, wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT id, name, username, role, active, created_at FROM users ORDER BY id');
  res.json(rows);
}));

app.post('/api/users', auth, adminOnly, wrap(async (req, res) => {
  const { name, username, password, role } = req.body || {};
  if (!name || !username) throw fail(400, 'Name and username are required.');
  if (!password || String(password).length < 6) throw fail(400, 'Password must be at least 6 characters.');
  if (!['admin', 'cashier'].includes(role)) throw fail(400, 'Role must be owner (admin) or cashier.');
  const { rows } = await pool.query(
    'INSERT INTO users (name, username, password_hash, role) VALUES ($1,$2,$3,$4) RETURNING id, name, username, role, active',
    [String(name).trim(), String(username).trim(), hashPassword(String(password)), role]
  );
  res.json(rows[0]);
}));

app.put('/api/users/:id', auth, adminOnly, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const { name, username, role, active, password } = req.body || {};
  if (id === req.user.id && (role === 'cashier' || active === false)) throw fail(400, "You can't remove your own owner access.");
  if (role && !['admin', 'cashier'].includes(role)) throw fail(400, 'Invalid role.');
  if (password !== undefined && password !== '' && String(password).length < 6) throw fail(400, 'Password must be at least 6 characters.');
  const { rows } = await pool.query(
    `UPDATE users SET
       name = COALESCE($1, name), username = COALESCE($2, username),
       role = COALESCE($3, role), active = COALESCE($4, active)
     WHERE id = $5 RETURNING id, name, username, role, active`,
    [name ?? null, username ?? null, role ?? null, active ?? null, id]
  );
  if (!rows.length) throw fail(404, 'User not found.');
  if (password) await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hashPassword(String(password)), id]);
  if (active === false || password) await pool.query('DELETE FROM sessions WHERE user_id = $1', [id]);
  res.json(rows[0]);
}));

// ---------------- categories ----------------
app.get('/api/categories', auth, wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.id, c.name, COUNT(p.id)::int AS product_count FROM categories c
     LEFT JOIN products p ON p.category_id = c.id AND p.active = TRUE
     GROUP BY c.id ORDER BY c.name`
  );
  res.json(rows);
}));
app.post('/api/categories', auth, adminOnly, wrap(async (req, res) => {
  const name = String((req.body || {}).name || '').trim();
  if (!name) throw fail(400, 'Category name is required.');
  const { rows } = await pool.query('INSERT INTO categories (name) VALUES ($1) RETURNING *', [name]);
  res.json(rows[0]);
}));
app.put('/api/categories/:id', auth, adminOnly, wrap(async (req, res) => {
  const name = String((req.body || {}).name || '').trim();
  if (!name) throw fail(400, 'Category name is required.');
  const { rows } = await pool.query('UPDATE categories SET name = $1 WHERE id = $2 RETURNING *', [name, Number(req.params.id)]);
  if (!rows.length) throw fail(404, 'Category not found.');
  res.json(rows[0]);
}));
app.delete('/api/categories/:id', auth, adminOnly, wrap(async (req, res) => {
  await pool.query('DELETE FROM categories WHERE id = $1', [Number(req.params.id)]);
  res.json({ ok: true });
}));

// ---------------- products ----------------
function cleanProduct(b) {
  const p = {
    name: String(b.name || '').trim(),
    category_id: b.category_id ? Number(b.category_id) : null,
    barcode: b.barcode ? String(b.barcode).trim() : null,
    cost_price: Number(b.cost_price || 0),
    sell_price: Number(b.sell_price || 0),
    stock_qty: parseInt(b.stock_qty || 0, 10),
    min_stock: parseInt(b.min_stock || 0, 10),
  };
  if (!p.name) throw fail(400, 'Product name is required.');
  if (!(p.sell_price >= 0) || !(p.cost_price >= 0)) throw fail(400, 'Prices must be 0 or more.');
  if (!Number.isFinite(p.stock_qty) || !Number.isFinite(p.min_stock)) throw fail(400, 'Stock must be a whole number.');
  return p;
}

app.get('/api/products', auth, wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT p.*, c.name AS category_name FROM products p
     LEFT JOIN categories c ON c.id = p.category_id
     WHERE p.active = TRUE ORDER BY p.name`
  );
  // cashiers don't see cost prices
  if (req.user.role !== 'admin') rows.forEach((r) => delete r.cost_price);
  res.json(rows);
}));

// owner and cashier can add products; only the owner sets the cost price
app.post('/api/products', auth, wrap(async (req, res) => {
  const p = cleanProduct(req.body || {});
  if (req.user.role !== 'admin') p.cost_price = 0;
  const { rows } = await pool.query(
    `INSERT INTO products (name, category_id, barcode, cost_price, sell_price, stock_qty, min_stock)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [p.name, p.category_id, p.barcode, p.cost_price, p.sell_price, p.stock_qty, p.min_stock]
  );
  res.json(rows[0]);
}));

app.put('/api/products/:id', auth, adminOnly, wrap(async (req, res) => {
  const p = cleanProduct(req.body || {});
  const { rows } = await pool.query(
    `UPDATE products SET name=$1, category_id=$2, barcode=$3, cost_price=$4, sell_price=$5, stock_qty=$6, min_stock=$7
     WHERE id=$8 RETURNING *`,
    [p.name, p.category_id, p.barcode, p.cost_price, p.sell_price, p.stock_qty, p.min_stock, Number(req.params.id)]
  );
  if (!rows.length) throw fail(404, 'Product not found.');
  res.json(rows[0]);
}));

// soft delete so old sales still show the product
app.delete('/api/products/:id', auth, adminOnly, wrap(async (req, res) => {
  await pool.query('UPDATE products SET active = FALSE, barcode = NULL WHERE id = $1', [Number(req.params.id)]);
  res.json({ ok: true });
}));

// ---------------- printing prices ----------------
app.get('/api/print-prices', auth, wrap(async (req, res) => {
  const prices = await pool.query('SELECT * FROM print_prices ORDER BY size, color, sided');
  const extras = await pool.query('SELECT * FROM print_extras WHERE active = TRUE ORDER BY name');
  res.json({ prices: prices.rows, extras: extras.rows });
}));

app.put('/api/print-prices', auth, adminOnly, wrap(async (req, res) => {
  const list = Array.isArray(req.body) ? req.body : [];
  for (const p of list) {
    const price = Number(p.price_per_page);
    if (!(price >= 0)) throw fail(400, 'Prices must be 0 or more.');
    if (!['bw', 'color'].includes(p.color) || !['single', 'double'].includes(p.sided) || !p.size) throw fail(400, 'Invalid print option.');
    await pool.query(
      `INSERT INTO print_prices (color, size, sided, price_per_page) VALUES ($1,$2,$3,$4)
       ON CONFLICT (color, size, sided) DO UPDATE SET price_per_page = EXCLUDED.price_per_page`,
      [p.color, String(p.size).trim().toUpperCase(), p.sided, price]
    );
  }
  res.json({ ok: true });
}));

app.delete('/api/print-prices/size/:size', auth, adminOnly, wrap(async (req, res) => {
  await pool.query('DELETE FROM print_prices WHERE size = $1', [req.params.size]);
  res.json({ ok: true });
}));

app.post('/api/print-extras', auth, adminOnly, wrap(async (req, res) => {
  const name = String((req.body || {}).name || '').trim();
  const price = Number((req.body || {}).price);
  if (!name || !(price >= 0)) throw fail(400, 'Name and a price of 0 or more are required.');
  const { rows } = await pool.query('INSERT INTO print_extras (name, price) VALUES ($1,$2) RETURNING *', [name, price]);
  res.json(rows[0]);
}));
app.put('/api/print-extras/:id', auth, adminOnly, wrap(async (req, res) => {
  const name = String((req.body || {}).name || '').trim();
  const price = Number((req.body || {}).price);
  if (!name || !(price >= 0)) throw fail(400, 'Name and a price of 0 or more are required.');
  const { rows } = await pool.query('UPDATE print_extras SET name=$1, price=$2 WHERE id=$3 RETURNING *', [name, price, Number(req.params.id)]);
  res.json(rows[0]);
}));
app.delete('/api/print-extras/:id', auth, adminOnly, wrap(async (req, res) => {
  await pool.query('UPDATE print_extras SET active = FALSE WHERE id = $1', [Number(req.params.id)]);
  res.json({ ok: true });
}));

// ---------------- sales / checkout ----------------
const SIZE_LABEL = (s) => s;
const COLOR_LABEL = { bw: 'B&W', color: 'Color' };
const SIDED_LABEL = { single: 'single-sided', double: 'double-sided' };

app.post('/api/sales', auth, wrap(async (req, res) => {
  const { items, discount_usd = 0, paid_usd = 0, paid_lbp = 0 } = req.body || {};
  if (!Array.isArray(items) || !items.length) throw fail(400, 'The cart is empty.');

  const settings = await getSettings();
  const rate = Number(settings.exchange_rate);
  const round = Number(settings.lbp_round || 1000);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lines = [];

    for (const it of items) {
      if (it.type === 'product') {
        const qty = parseInt(it.qty, 10);
        if (!(qty > 0)) throw fail(400, 'Quantity must be at least 1.');
        const { rows } = await client.query('SELECT * FROM products WHERE id = $1 AND active = TRUE FOR UPDATE', [Number(it.product_id)]);
        const p = rows[0];
        if (!p) throw fail(400, 'A product in the cart no longer exists. Remove it and try again.');
        if (p.stock_qty < qty) throw fail(400, `Not enough "${p.name}" in stock (${p.stock_qty} left). Ask the owner to update the stock.`);
        await client.query('UPDATE products SET stock_qty = stock_qty - $1 WHERE id = $2', [qty, p.id]);
        lines.push({
          item_type: 'product', product_id: p.id, description: p.name, qty,
          unit_price: Number(p.sell_price), cost_price: Number(p.cost_price), line_total: r2(Number(p.sell_price) * qty),
        });
      } else if (it.type === 'print') {
        const pages = parseInt(it.pages, 10);
        const copies = parseInt(it.copies, 10);
        if (!(pages > 0) || !(copies > 0)) throw fail(400, 'Pages and copies must be at least 1.');
        const { rows } = await client.query('SELECT * FROM print_prices WHERE color=$1 AND size=$2 AND sided=$3', [it.color, it.size, it.sided]);
        if (!rows.length) throw fail(400, 'No price is set for this print option. Ask the owner to add it.');
        const perPage = Number(rows[0].price_per_page);
        const printCost = pages * copies * perPage;
        const desc = `Print ${COLOR_LABEL[it.color]} ${SIZE_LABEL(it.size)} ${SIDED_LABEL[it.sided]} — ${pages} pg × ${copies}`;
        lines.push({ item_type: 'print', product_id: null, description: desc, qty: pages * copies, unit_price: perPage, cost_price: 0, line_total: r2(printCost) });

        const extraIds = Array.isArray(it.extras) ? it.extras.map(Number) : [];
        for (const eid of extraIds) {
          const ex = await client.query('SELECT * FROM print_extras WHERE id = $1 AND active = TRUE', [eid]);
          if (!ex.rows.length) continue;
          const e = ex.rows[0];
          lines.push({ item_type: 'print', product_id: null, description: e.name, qty: copies, unit_price: Number(e.price), cost_price: 0, line_total: r2(Number(e.price) * copies) });
        }
      } else {
        throw fail(400, 'Unknown item in cart.');
      }
    }

    const subtotal = r2(lines.reduce((s, l) => s + l.line_total, 0));
    const discount = r2(Math.max(0, Number(discount_usd) || 0));
    if (discount > subtotal) throw fail(400, 'Discount is bigger than the total.');
    const total = r2(subtotal - discount);

    // payment check (in LBP to handle mixed payments)
    const pUsd = Math.max(0, Number(paid_usd) || 0);
    const pLbp = Math.max(0, Math.round(Number(paid_lbp) || 0));
    const totalLbp = total * rate;
    const paidLbpEq = pUsd * rate + pLbp;
    if (paidLbpEq + round / 2 < totalLbp) throw fail(400, 'Payment is less than the total.');
    const change = Math.max(0, Math.round((paidLbpEq - totalLbp) / round) * round);

    const sale = await client.query(
      `INSERT INTO sales (user_id, subtotal_usd, discount_usd, total_usd, exchange_rate, paid_usd, paid_lbp, change_lbp)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.user.id, subtotal, discount, total, rate, pUsd, pLbp, change]
    );
    const saleId = sale.rows[0].id;
    for (const l of lines) {
      await client.query(
        `INSERT INTO sale_items (sale_id, item_type, product_id, description, qty, unit_price, cost_price, line_total)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [saleId, l.item_type, l.product_id, l.description, l.qty, l.unit_price, l.cost_price, l.line_total]
      );
    }
    await client.query('COMMIT');
    res.json({ ...sale.rows[0], cashier: req.user.name, items: lines });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}));

// today's sales (cashier sees their own, owner sees everyone's)
app.get('/api/sales', auth, wrap(async (req, res) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : null;
  const tz = process.env.TZ_NAME || 'Asia/Beirut';
  const params = [tz];
  let where = `(s.created_at AT TIME ZONE $1)::date = ${date ? '$2::date' : '(NOW() AT TIME ZONE $1)::date'}`;
  if (date) params.push(date);
  if (req.user.role !== 'admin') { params.push(req.user.id); where += ` AND s.user_id = $${params.length}`; }
  const { rows } = await pool.query(
    `SELECT s.*, u.name AS cashier,
       (SELECT json_agg(json_build_object('description', i.description, 'qty', i.qty, 'unit_price', i.unit_price, 'line_total', i.line_total, 'item_type', i.item_type) ORDER BY i.id)
        FROM sale_items i WHERE i.sale_id = s.id) AS items
     FROM sales s LEFT JOIN users u ON u.id = s.user_id
     WHERE ${where} ORDER BY s.created_at DESC`,
    params
  );
  res.json(rows);
}));

// void a sale (owner only) — puts stock back
app.post('/api/sales/:id/void', auth, adminOnly, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM sales WHERE id = $1 FOR UPDATE', [id]);
    if (!rows.length) throw fail(404, 'Sale not found.');
    if (rows[0].voided) throw fail(400, 'This sale is already voided.');
    const items = await client.query("SELECT product_id, qty FROM sale_items WHERE sale_id = $1 AND item_type = 'product' AND product_id IS NOT NULL", [id]);
    for (const it of items.rows) {
      await client.query('UPDATE products SET stock_qty = stock_qty + $1 WHERE id = $2', [it.qty, it.product_id]);
    }
    await client.query('UPDATE sales SET voided = TRUE, voided_by = $1 WHERE id = $2', [req.user.id, id]);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}));

// =====================================================================
// CUSTOMER SIDE (public, no login): print uploads, shop orders, tracking
// =====================================================================
const MAX_FILE_MB = 25;
const ALLOWED_MIME = /^(application\/pdf|image\/(jpeg|png|webp|heic|heif)|application\/msword|application\/vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|presentationml\.presentation)|application\/vnd\.ms-powerpoint)$/;
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

// tiny in-memory rate limit per IP so nobody floods the shop
const hits = new Map();
function rateLimit(req, bucket, max, minutes) {
  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
  const key = bucket + ':' + ip;
  const now = Date.now();
  const list = (hits.get(key) || []).filter((t) => now - t < minutes * 60000);
  if (list.length >= max) throw fail(429, 'Too many requests. Please wait a few minutes and try again.');
  list.push(now);
  hits.set(key, list);
  if (hits.size > 5000) hits.clear();
}

async function onlineEnabled() {
  const s = await getSettings();
  if (s.online_orders === 'off') throw fail(403, 'Online orders are paused right now. Please contact the shop.');
  return s;
}

const cleanPhone = (p) => String(p || '').replace(/[^\d+]/g, '');

app.get('/api/public/shop', wrap(async (req, res) => {
  const s = await getSettings();
  const products = await pool.query(
    `SELECT p.id, p.name, p.category_id, p.sell_price, (p.stock_qty > 0) AS in_stock, LEAST(p.stock_qty, 99) AS max_qty
     FROM products p WHERE p.active = TRUE ORDER BY p.name`
  );
  const categories = await pool.query(
    `SELECT c.id, c.name FROM categories c WHERE EXISTS (SELECT 1 FROM products p WHERE p.category_id = c.id AND p.active) ORDER BY c.name`
  );
  const prices = await pool.query('SELECT color, size, sided, price_per_page FROM print_prices ORDER BY size, color, sided');
  const extras = await pool.query('SELECT id, name, price FROM print_extras WHERE active = TRUE ORDER BY name');
  res.json({
    shop: {
      name: s.shop_name, enabled: s.online_orders !== 'off', whatsapp: s.whatsapp_number || '',
      hours: s.shop_hours || '', address: s.shop_address || '',
      exchange_rate: Number(s.exchange_rate), lbp_round: Number(s.lbp_round || 1000), max_file_mb: MAX_FILE_MB,
    },
    products: products.rows, categories: categories.rows, prices: prices.rows, extras: extras.rows,
  });
}));

// 1) customer uploads a file (raw body) -> gets an id + secret key to attach it to an order
app.post('/api/public/uploads', express.raw({ type: () => true, limit: MAX_FILE_MB + 1 + 'mb' }), wrap(async (req, res) => {
  await onlineEnabled();
  rateLimit(req, 'upload', 60, 60);
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || !buf.length) throw fail(400, 'The file is empty.');
  if (buf.length > MAX_FILE_MB * 1024 * 1024) throw fail(400, `Files must be under ${MAX_FILE_MB} MB.`);
  const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!ALLOWED_MIME.test(mime)) throw fail(400, 'Send PDF, Word, PowerPoint or photo files.');
  let name = 'file';
  try { name = decodeURIComponent(String(req.headers['x-filename'] || 'file')); } catch {}
  name = name.replace(/[\\/\r\n"]/g, '_').slice(0, 150) || 'file';
  const key = crypto.randomBytes(16).toString('hex');
  const { rows } = await pool.query(
    `INSERT INTO order_files (upload_key, filename, mime, size, data) VALUES ($1,$2,$3,$4, decode($5,'base64')) RETURNING id`,
    [key, name, mime, buf.length, buf.toString('base64')]
  );
  // clear files that were uploaded but never sent with an order
  await pool.query(`DELETE FROM order_files WHERE order_id IS NULL AND created_at < NOW() - INTERVAL '1 day'`);
  res.json({ id: rows[0].id, key });
}));

// 2) customer sends the order
app.post('/api/public/orders', wrap(async (req, res) => {
  await onlineEnabled();
  rateLimit(req, 'order', 10, 60);
  const { name, phone, note = '', items } = req.body || {};
  const cname = String(name || '').trim().slice(0, 60);
  const cphone = cleanPhone(phone);
  if (cname.length < 2) throw fail(400, 'Please enter your name.');
  if (cphone.replace('+', '').length < 7 || cphone.length > 16) throw fail(400, 'Please enter a valid phone number.');
  if (!Array.isArray(items) || !items.length) throw fail(400, 'Your order is empty.');
  if (items.length > 40) throw fail(400, 'Too many items in one order.');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lines = [];
    for (const it of items) {
      if (it.type === 'product') {
        const qty = parseInt(it.qty, 10);
        if (!(qty > 0 && qty <= 100)) throw fail(400, 'Quantity must be between 1 and 100.');
        const { rows } = await client.query('SELECT * FROM products WHERE id = $1 AND active = TRUE', [Number(it.product_id)]);
        const p = rows[0];
        if (!p) throw fail(400, 'A product in your order is no longer available. Please remove it.');
        if (p.stock_qty < qty) throw fail(400, p.stock_qty > 0 ? `Only ${p.stock_qty} "${p.name}" left. Please lower the quantity.` : `"${p.name}" is out of stock. Please remove it.`);
        lines.push({ item_type: 'product', product_id: p.id, description: p.name, qty, line_total: r2(Number(p.sell_price) * qty) });
      } else if (it.type === 'print') {
        const pages = parseInt(it.pages, 10);
        const copies = parseInt(it.copies, 10);
        if (!(pages > 0 && pages <= 3000)) throw fail(400, 'Pages must be between 1 and 3000.');
        if (!(copies > 0 && copies <= 500)) throw fail(400, 'Copies must be between 1 and 500.');
        const f = await client.query('SELECT id, filename FROM order_files WHERE id = $1 AND upload_key = $2 AND order_id IS NULL', [Number(it.file_id), String(it.file_key || '')]);
        if (!f.rows.length) throw fail(400, 'One of your files did not upload. Please remove it and add it again.');
        const pr = await client.query('SELECT price_per_page FROM print_prices WHERE color=$1 AND size=$2 AND sided=$3', [it.color, it.size, it.sided]);
        if (!pr.rows.length) throw fail(400, 'That print option is not available. Please choose another.');
        let total = pages * copies * Number(pr.rows[0].price_per_page);
        const extraIds = [];
        const extraNames = [];
        for (const eid of Array.isArray(it.extras) ? it.extras.map(Number) : []) {
          const ex = await client.query('SELECT * FROM print_extras WHERE id = $1 AND active = TRUE', [eid]);
          if (!ex.rows.length) continue;
          total += Number(ex.rows[0].price) * copies;
          extraIds.push(eid); extraNames.push(ex.rows[0].name);
        }
        const desc = `${f.rows[0].filename} — ${COLOR_LABEL[it.color]} ${it.size} ${SIDED_LABEL[it.sided]}, ${pages} pg × ${copies}${extraNames.length ? ' + ' + extraNames.join(', ') : ''}`;
        lines.push({ item_type: 'print', description: desc, qty: copies, line_total: r2(total), color: it.color, size: it.size, sided: it.sided, pages, copies, extras: JSON.stringify(extraIds), file_id: f.rows[0].id });
      } else throw fail(400, 'Unknown item in your order.');
    }
    const total = r2(lines.reduce((s, l) => s + l.line_total, 0));

    // short code staff can read out loud, unique among open orders
    let code = '';
    for (let tries = 0; tries < 20; tries++) {
      code = Array.from(crypto.randomBytes(4)).map((b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
      const dup = await client.query(`SELECT 1 FROM online_orders WHERE code = $1 AND status NOT IN ('picked_up','cancelled')`, [code]);
      if (!dup.rows.length) break;
    }
    const token = crypto.randomBytes(18).toString('hex');
    const o = await client.query(
      'INSERT INTO online_orders (code, token, customer_name, phone, note, total_usd) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [code, token, cname, cphone, String(note).trim().slice(0, 500), total]
    );
    const orderId = o.rows[0].id;
    for (const l of lines) {
      await client.query(
        `INSERT INTO online_order_items (order_id, item_type, product_id, description, qty, line_total, color, size, sided, pages, copies, extras, file_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [orderId, l.item_type, l.product_id || null, l.description, l.qty, l.line_total, l.color || null, l.size || null, l.sided || null, l.pages || null, l.copies || null, l.extras || '[]', l.file_id || null]
      );
      if (l.file_id) await client.query('UPDATE order_files SET order_id = $1 WHERE id = $2', [orderId, l.file_id]);
    }
    await client.query('COMMIT');
    res.json({ code, token, total_usd: total });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}));

async function publicOrder(token) {
  const { rows } = await pool.query('SELECT * FROM online_orders WHERE token = $1', [String(token || '')]);
  if (!rows.length) throw fail(404, 'Order not found. Check your link.');
  return rows[0];
}

// 3) customer tracks the order
app.get('/api/public/orders/:token', wrap(async (req, res) => {
  const o = await publicOrder(req.params.token);
  const items = await pool.query('SELECT item_type, description, qty, line_total FROM online_order_items WHERE order_id = $1 ORDER BY id', [o.id]);
  const s = await getSettings();
  res.json({
    code: o.code, status: o.status, name: o.customer_name, total_usd: o.total_usd,
    created_at: o.created_at, updated_at: o.updated_at, items: items.rows,
    shop: { name: s.shop_name, whatsapp: s.whatsapp_number || '', hours: s.shop_hours || '', address: s.shop_address || '', exchange_rate: Number(s.exchange_rate), lbp_round: Number(s.lbp_round || 1000) },
  });
}));

// customer can cancel only before the shop starts working on it
app.post('/api/public/orders/:token/cancel', wrap(async (req, res) => {
  const o = await publicOrder(req.params.token);
  if (o.status !== 'received') throw fail(400, 'The shop already started this order. Please contact them to cancel.');
  await pool.query(`UPDATE online_orders SET status = 'cancelled', updated_at = NOW() WHERE id = $1`, [o.id]);
  res.json({ ok: true });
}));

// ---------------- staff: online orders ----------------
const NEXT_STATUS = {
  received: ['preparing', 'ready', 'cancelled'],
  preparing: ['ready', 'received', 'cancelled'],
  ready: ['preparing', 'cancelled'],
  picked_up: [],
  cancelled: ['received'],
};

app.get('/api/orders/new-count', auth, wrap(async (req, res) => {
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS n, COALESCE(MAX(id),0) AS last_id FROM online_orders WHERE status = 'received'`);
  res.json(rows[0]);
}));

app.get('/api/orders', auth, wrap(async (req, res) => {
  const done = req.query.view === 'done';
  const { rows } = await pool.query(
    `SELECT o.id, o.code, o.customer_name, o.phone, o.note, o.status, o.total_usd, o.sale_id, o.created_at, o.updated_at,
       (SELECT json_agg(json_build_object('id', i.id, 'item_type', i.item_type, 'product_id', i.product_id, 'description', i.description,
          'qty', i.qty, 'line_total', i.line_total, 'color', i.color, 'size', i.size, 'sided', i.sided, 'pages', i.pages,
          'copies', i.copies, 'extras', i.extras, 'file_id', i.file_id,
          'file_name', f.filename, 'file_size', f.size, 'file_ok', (f.data IS NOT NULL)) ORDER BY i.id)
        FROM online_order_items i LEFT JOIN order_files f ON f.id = i.file_id WHERE i.order_id = o.id) AS items
     FROM online_orders o
     WHERE ${done ? `o.status IN ('picked_up','cancelled')` : `o.status IN ('received','preparing','ready')`}
     ORDER BY ${done ? 'o.updated_at DESC LIMIT 60' : 'o.created_at ASC'}`
  );
  res.json(rows);
}));

app.get('/api/orders/:id/files/:fileId', auth, wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT filename, mime, encode(data, 'base64') AS b64 FROM order_files WHERE id = $1 AND order_id = $2`,
    [Number(req.params.fileId), Number(req.params.id)]
  );
  if (!rows.length || !rows[0].b64) throw fail(404, 'This file was removed. Files are kept for 7 days after an order is finished.');
  const buf = Buffer.from(rows[0].b64.replace(/\s/g, ''), 'base64');
  res.setHeader('Content-Type', rows[0].mime);
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(rows[0].filename)}"`);
  res.setHeader('Content-Length', buf.length);
  res.end(buf);
}));

async function purgeOldFiles() {
  await pool.query(
    `UPDATE order_files SET data = NULL WHERE data IS NOT NULL AND order_id IN
       (SELECT id FROM online_orders WHERE status IN ('picked_up','cancelled') AND updated_at < NOW() - INTERVAL '7 days')`
  );
}

app.put('/api/orders/:id/status', auth, wrap(async (req, res) => {
  const status = String((req.body || {}).status || '');
  const { rows } = await pool.query('SELECT status FROM online_orders WHERE id = $1', [Number(req.params.id)]);
  if (!rows.length) throw fail(404, 'Order not found.');
  if (!(NEXT_STATUS[rows[0].status] || []).includes(status)) throw fail(400, `Can't move this order from "${rows[0].status}" to "${status}".`);
  await pool.query('UPDATE online_orders SET status = $1, handled_by = $2, updated_at = NOW() WHERE id = $3', [status, req.user.id, Number(req.params.id)]);
  await purgeOldFiles();
  res.json({ ok: true });
}));

// called after the till completes the sale for this order
app.post('/api/orders/:id/complete', auth, wrap(async (req, res) => {
  const saleId = Number((req.body || {}).sale_id);
  const sale = await pool.query('SELECT id FROM sales WHERE id = $1 AND voided = FALSE', [saleId]);
  if (!sale.rows.length) throw fail(400, 'Sale not found.');
  const { rows } = await pool.query(
    `UPDATE online_orders SET status = 'picked_up', sale_id = $1, handled_by = $2, updated_at = NOW()
     WHERE id = $3 AND status IN ('received','preparing','ready') RETURNING id`,
    [saleId, req.user.id, Number(req.params.id)]
  );
  if (!rows.length) throw fail(400, 'This order is already finished.');
  await purgeOldFiles();
  res.json({ ok: true });
}));

// customer pages
app.get(['/order', '/order/'], (req, res) => res.sendFile(path.join(__dirname, 'public', 'order.html')));
app.get('/track/:token', (req, res) => res.sendFile(path.join(__dirname, 'public', 'order.html')));

// any other route -> the app
app.get('*',(req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
init()
  .then(() => app.listen(PORT, () => console.log(`On the Spot running on http://localhost:${PORT}`)))
  .catch((e) => {
    console.error('Could not start — database problem:', e.message);
    process.exit(1);
  });
