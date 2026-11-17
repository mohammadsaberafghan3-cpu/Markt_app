# NOVA MARKET — marketplace finance milestone

A Persian RTL, mobile-first multi-vendor marketplace. This branch preserves the existing `main` branch and the older deployment.

## What this milestone implements

- Persian RTL storefront, product search/category filtering, cart, customer accounts and vendor onboarding
- Seller application status: pending, approved, rejected; rejected applications can be resubmitted
- Admin approval controls vendor access; vendor endpoints verify current approval on every request
- Global commission rate (0–50%) configurable by admin; optional per-vendor commission override
- Commission rate and amount are snapshotted per order line so later settings changes do not rewrite old sales
- Currency code, symbol and display name are configurable by admin; initial default is IRR / تومان
- Explicit test-only payment transactions with unique references, idempotency keys and guarded state transitions
- Test payment confirmation checks stock again, decrements stock once, and credits vendor wallets once
- Vendor wallet ledger and available balance
- Settlement reservation: requests immediately reserve available funds; approval keeps funds reserved; rejection/cancellation releases them
- Manual payout recording requires a reference and is clearly marked as an action performed outside NOVA
- Admin finance settings, payment transaction list, seller commission, settlement queue and audit events
- Additive SQLite migrations; existing tables and columns are preserved

## Payment and financial boundaries

**Payment mode is hard-coded to TEST in this milestone.** The app does not connect to a bank, card processor, payment gateway, or payout provider. The `test-confirm` endpoint only simulates a successful payment inside the database. Never use it to accept real customer money.

A settlement marked `paid_manual` means an administrator entered a reference after arranging a transfer outside this application. NOVA does not initiate or verify a bank transfer.

Refunds/chargebacks, automated payouts, shipping integrations, persistent media storage, product variants, notifications, full tax/accounting reports, and browser-based end-to-end testing are not implemented in this milestone.

## SQLite migration notes

On startup, the application adds missing finance columns and tables without dropping existing tables. It stores global settings, payment transactions, per-order commission snapshots, and settlement references. Existing pending settlements are reserved once when possible; legacy requests that exceed the existing wallet balance are marked `needs_review` rather than silently overdrawn.

Back up the database before deploying a schema update. Render Free's `/tmp` storage is ephemeral; use a persistent disk or managed database before storing real customer data.

## Local setup

Requirements: Node.js 20+ and native build tools for `better-sqlite3`.

```bash
npm install
ADMIN_EMAIL='admin@example.com' \
ADMIN_PASSWORD='use-a-unique-password-of-at-least-10-characters' \
SESSION_SECRET='use-a-long-random-secret' \
DATABASE_PATH='./data/nova.sqlite' \
npm start
```

Open `http://localhost:3000`. The initial admin account is created from the environment variables on first database initialization. If you already have an admin account, changing `ADMIN_PASSWORD` does not overwrite its existing password.

## Automated verification

```bash
npm run check
npm test
```

The integration test covers registration, seller approval, commission snapshot, idempotent checkout, test payment success/failure, single wallet credit, settlement reservation/release/manual payout state, currency settings and role restrictions.

GitHub Actions also creates a `nova_marketplace_mvp.zip` artifact after successful checks. Download it from the latest successful workflow run's **Artifacts** section.

## Deploying a separate preview on Render

1. Create a new Blueprint from this repository and select branch `nova-market-rebuild`.
2. Keep the current `main`-based service unchanged.
3. Set a strong `ADMIN_PASSWORD`; Render generates `SESSION_SECRET`.
4. Wait for deploy completion and verify `/health`.

A passing CI run verifies syntax and the automated API/database test paths only. It does not prove that a Render deployment, production persistence, payment gateway, manual bank payout, or complete browser experience has been verified.
