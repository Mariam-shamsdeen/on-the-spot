# On the Spot — POS system

Till, stock and printing system for **On the Spot** (copybooks, pens, pencils + printing).
Express server + vanilla JS + PostgreSQL.

## What's in version 1

- **Login with roles**: Owner (admin) and Cashier
- **Sell screen**: product tiles, search, barcode scanning (type/scan + Enter), category filters
- **Print jobs**: B&W / color, A4 / A3, single / double sided, pages × copies, extras (binding, lamination…), price calculated automatically
- **Payment in $ and LBP** (or mixed), change calculated and rounded, receipt that prints on 80mm paper
- **Stock** goes down automatically on every sale; low-stock warnings
- **Today's sales**: totals, products vs printing income; owner can pick any date and **void** a sale (stock goes back)
- **Owner only**: products & categories, cost prices / profit, printing prices, staff accounts, dollar rate, settings
- Cashiers never see cost prices and can't change prices or delete sales

## Run on your computer

1. Install Node.js 18+ and PostgreSQL
2. Create a database: `createdb onthespot`
3. In this folder:
   ```
   npm install
   npm start
   ```
4. Open http://localhost:3000

If your Postgres username/password are not `postgres/postgres`, set `DATABASE_URL`:
```
DATABASE_URL=postgres://USER:PASSWORD@localhost:5432/onthespot npm start
```

Tables are created automatically on first start.

**First login:** username `admin`, password `admin123` → change it right away (Password button, bottom left).

## Deploy on Render (same as A&B Delivery)

1. Push this folder to a new GitHub repo
2. On Render: create a **PostgreSQL** database, copy its *Internal Database URL*
3. Create a **Web Service** from the repo
   - Build command: `npm install`
   - Start command: `npm start`
   - Environment variable: `DATABASE_URL` = the URL from step 2
4. Optional: `TZ_NAME` (default `Asia/Beirut`) for what counts as "today"

## Files

- `server.js` — API routes (login, products, printing, sales, staff, settings)
- `db.js` — database connection, tables, first admin + default printing prices
- `public/` — the app (index.html, app.js, style.css)

## Next steps (planned)

- Print queue for big jobs (pending → printing → ready → picked up)
- Stock-in history from suppliers
- Reports: profit, best sellers, monthly totals
