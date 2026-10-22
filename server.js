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
  const allowed = ['shop_name', 'exchange_rate', 'lbp_round', 'receipt_footer'];
  const body = req.body || {};
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

// any other route -> the app
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
init()
  .then(() => app.listen(PORT, () => console.log(`On the Spot running on http://localhost:${PORT}`)))
  .catch((e) => {
    console.error('Could not start — database problem:', e.message);
    process.exit(1);
  });
