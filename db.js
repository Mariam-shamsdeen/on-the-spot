// Database connection + schema setup
const { Pool } = require('pg');
const crypto = require('crypto');

const connectionString = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/onthespot';
const useSSL = !!process.env.DATABASE_URL && !/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL);

const pool = new Pool({
  connectionString,
  ssl: useSSL ? { rejectUnauthorized: false } : false,
});

// ---------- password hashing (built-in crypto, no extra package) ----------
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function checkPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(password, salt, 64);
  const real = Buffer.from(hash, 'hex');
  return real.length === test.length && crypto.timingSafeEqual(real, test);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','cashier')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  barcode TEXT UNIQUE,
  cost_price NUMERIC(12,2) NOT NULL DEFAULT 0,
  sell_price NUMERIC(12,2) NOT NULL DEFAULT 0,
  stock_qty INTEGER NOT NULL DEFAULT 0,
  min_stock INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS print_prices (
  id SERIAL PRIMARY KEY,
  color TEXT NOT NULL CHECK (color IN ('bw','color')),
  size TEXT NOT NULL,
  sided TEXT NOT NULL CHECK (sided IN ('single','double')),
  price_per_page NUMERIC(12,3) NOT NULL DEFAULT 0,
  UNIQUE (color, size, sided)
);

CREATE TABLE IF NOT EXISTS print_extras (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  price NUMERIC(12,2) NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS sales (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  subtotal_usd NUMERIC(12,2) NOT NULL,
  discount_usd NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_usd NUMERIC(12,2) NOT NULL,
  exchange_rate NUMERIC(14,2) NOT NULL,
  paid_usd NUMERIC(12,2) NOT NULL DEFAULT 0,
  paid_lbp NUMERIC(16,0) NOT NULL DEFAULT 0,
  change_lbp NUMERIC(16,0) NOT NULL DEFAULT 0,
  voided BOOLEAN NOT NULL DEFAULT FALSE,
  voided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sale_items (
  id SERIAL PRIMARY KEY,
  sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  item_type TEXT NOT NULL CHECK (item_type IN ('product','print')),
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  description TEXT NOT NULL,
  qty INTEGER NOT NULL,
  unit_price NUMERIC(12,3) NOT NULL,
  cost_price NUMERIC(12,2) NOT NULL DEFAULT 0,
  line_total NUMERIC(12,2) NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

ALTER TABLE online_orders ADD COLUMN IF NOT EXISTS customer_edited BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE products ADD COLUMN IF NOT EXISTS image BYTEA;
ALTER TABLE products ADD COLUMN IF NOT EXISTS image_mime TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS image_v INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_sales_created ON sales(created_at);
CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id);

-- ---------- customer side: online orders ----------
CREATE TABLE IF NOT EXISTS online_orders (
  id SERIAL PRIMARY KEY,
  code TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  customer_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received','preparing','ready','picked_up','cancelled')),
  total_usd NUMERIC(12,2) NOT NULL DEFAULT 0,
  sale_id INTEGER REFERENCES sales(id) ON DELETE SET NULL,
  handled_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS order_files (
  id SERIAL PRIMARY KEY,
  order_id INTEGER REFERENCES online_orders(id) ON DELETE CASCADE,
  upload_key TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  data BYTEA,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS online_order_items (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES online_orders(id) ON DELETE CASCADE,
  item_type TEXT NOT NULL CHECK (item_type IN ('product','print')),
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  description TEXT NOT NULL,
  qty INTEGER NOT NULL,
  line_total NUMERIC(12,2) NOT NULL,
  color TEXT, size TEXT, sided TEXT, pages INTEGER, copies INTEGER,
  extras TEXT NOT NULL DEFAULT '[]',
  file_id INTEGER REFERENCES order_files(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_orders_status ON online_orders(status);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON online_order_items(order_id);
`;

async function init() {
  await pool.query(SCHEMA);

  // default settings
  const defaults = {
    shop_name: 'On the Spot',
    exchange_rate: '89500',
    lbp_round: '1000',
    receipt_footer: 'Thank you for shopping with us!',
    online_orders: 'on',
    whatsapp_number: '',
    shop_hours: '',
    shop_address: '',
  };
  for (const [k, v] of Object.entries(defaults)) {
    await pool.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [k, v]);
  }

  // first admin account
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM users');
  if (rows[0].n === 0) {
    await pool.query(
      'INSERT INTO users (name, username, password_hash, role) VALUES ($1, $2, $3, $4)',
      ['Shop owner', 'admin', hashPassword('admin123'), 'admin']
    );
    console.log('Created first admin account -> username: admin  password: admin123  (change it after logging in)');
  }

  // forgot the owner password? set RESET_ADMIN_PASSWORD on Render, deploy, log in, then remove it
  const reset = process.env.RESET_ADMIN_PASSWORD;
  if (reset) {
    if (String(reset).length < 6) {
      console.log('RESET_ADMIN_PASSWORD must be at least 6 characters. Nothing was changed.');
    } else {
      const r = await pool.query(
        `UPDATE users SET password_hash = $1, active = TRUE, role = 'admin'
         WHERE id = (SELECT id FROM users WHERE LOWER(username) = 'admin' OR role = 'admin' ORDER BY (LOWER(username) = 'admin') DESC, id LIMIT 1)
         RETURNING username`,
        [hashPassword(String(reset))]
      );
      if (r.rows.length) {
        await pool.query('DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = $1)', [r.rows[0].username]);
        console.log(`Owner password was reset for username "${r.rows[0].username}". Remove RESET_ADMIN_PASSWORD from Render now.`);
      }
    }
  }

  // default print prices (owner edits them later)
  const pp = await pool.query('SELECT COUNT(*)::int AS n FROM print_prices');
  if (pp.rows[0].n === 0) {
    const seed = [
      ['bw', 'A4', 'single', 0.05], ['bw', 'A4', 'double', 0.08],
      ['color', 'A4', 'single', 0.25], ['color', 'A4', 'double', 0.45],
      ['bw', 'A3', 'single', 0.15], ['bw', 'A3', 'double', 0.25],
      ['color', 'A3', 'single', 0.60], ['color', 'A3', 'double', 1.10],
    ];
    for (const s of seed) {
      await pool.query('INSERT INTO print_prices (color, size, sided, price_per_page) VALUES ($1,$2,$3,$4)', s);
    }
  }
  const pe = await pool.query('SELECT COUNT(*)::int AS n FROM print_extras');
  if (pe.rows[0].n === 0) {
    for (const [n, p] of [['Spiral binding', 1.5], ['Lamination', 0.75], ['Plastic cover', 0.5]]) {
      await pool.query('INSERT INTO print_extras (name, price) VALUES ($1,$2)', [n, p]);
    }
  }
}

module.exports = { pool, init, hashPassword, checkPassword };
