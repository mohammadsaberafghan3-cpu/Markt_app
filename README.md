# NOVA MARKET 2.0 — from-scratch rebuild

A new independent implementation of the NOVA MARKET multi-vendor marketplace. Work is isolated on the `nova-market-rebuild` branch; the existing `main` deployment is intentionally preserved.

## Stack
- Node.js 20+, Express
- SQLite via better-sqlite3, foreign keys and transactional order creation
- Vanilla HTML/CSS/JavaScript, Persian RTL and responsive mobile-first layout
- Session authentication, bcrypt password hashing and role-protected APIs

## Deploy preview
Connect this branch to a separate Render preview service using the included Blueprint. Set a unique strong `ADMIN_PASSWORD` and `SESSION_SECRET`. The admin email is configurable using `ADMIN_EMAIL`.

## Current implementation
- Premium RTL storefront, category filter, search, product cards and cart
- Customer registration/login and order history
- Vendor application and approval workflow
- Vendor product management, vendor-specific orders and wallet summary
- Admin overview, vendor approvals, order overview and settlement decisions
- Test-mode checkout, inventory decrement, commission calculation and wallet ledger
- Health endpoint at `/health`

## Explicit limitations
- Checkout records a test-mode order; no real payment gateway is connected.
- Settlement approval updates the internal ledger; it does not transfer money.
- Returns/refunds, shipping integrations, image upload pipeline, notifications, product variants, customer management UI, advanced reports, and automated browser/E2E tests are not implemented yet.
- Render Free uses temporary filesystem storage. Data is not safe for production.
- This is a working foundation under development, not a production-certified marketplace.

## Local run
Node.js 20+ and native build tools are required for better-sqlite3. Run `npm install`, set `ADMIN_PASSWORD` and `SESSION_SECRET`, then `npm start`.
