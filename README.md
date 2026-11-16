# NOVA MARKET — mobile-first online preview

This repository contains the deployment wrapper for the NOVA MARKET application.

## One-time setup from an Android phone (no terminal)

1. Download `nova_marketplace_refunds_phase.zip` from the ChatGPT conversation.
2. Open this repository: https://github.com/mohammadsaberafghan3-cpu/Markt_app
3. In GitHub, choose **Add file → Upload files** (or the upload option in the mobile browser menu).
4. Upload the ZIP to the repository root. Keep the exact filename:
   `nova_marketplace_refunds_phase.zip`
5. Commit the upload to the `main` branch.
6. Open Render and create a new **Blueprint** from this GitHub repository. Render reads `render.yaml`.
7. When Render asks for `ADMIN_PASSWORD`, enter a new strong password and save it.
8. Wait for the Docker build and deployment to finish. Open the generated `.onrender.com` URL.

## Important preview limitations

- This blueprint uses Render's free web-service plan so the first visual preview can be launched without choosing a paid plan.
- Free services may sleep when idle and can take a short time to wake up.
- The free preview uses temporary storage under `/tmp`. Database records and uploaded product images are **not guaranteed to persist** across restarts or redeployments. Do not use it for real customers or real orders.
- A production deployment needs persistent storage or a managed database, a stable domain, backups, and real payment-provider integration.
- Payments and refunds in this code are test-mode simulations only.

## Application

- Node.js 20+
- Express + SQLite
- Persian RTL storefront
- Admin, seller, and customer areas
- Test-mode checkout, seller commission ledger, settlement requests, and full-refund workflow

The Dockerfile extracts the application source from the uploaded ZIP and installs production dependencies automatically. No terminal commands are required from the phone user.
