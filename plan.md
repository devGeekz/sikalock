# SikaLock — Setup Plan

## Overview

SikaLock is a USSD-based escrow service that lets informal traders safely buy and sell goods across regions without either side having to trust the other upfront.

## Stack

| Layer | Choice | Why |
|-------|--------|-----|
| Backend | Node.js + Express | MoMo has a Node SDK, simple for solo dev |
| Database | PostgreSQL | Free, handles financial transactions well |
| USSD Gateway | Africa's Talking (sandbox) | Free for dev/testing; production via BMS Africa when ready to launch |
| MoMo | MTN MoMo Open API (Sandbox) | Official sandbox, Collection + Disbursement APIs |
| Containerization | Docker + Docker Compose | App + PostgreSQL in one `docker compose up` |
| Local dev tunnel | ngrok | Expose localhost for webhook testing |

## Prerequisites

Install these before starting:

| Tool | Purpose |
|------|---------|
| Docker Desktop | Runs app + PostgreSQL containers |
| Node.js 18+ | Local JS runtime (for scripts outside Docker) |
| ngrok | Expose localhost for USSD webhook callbacks |

### Account Setup

1. **Africa's Talking sandbox** — https://sandbox.africastalking.com
   - Sign up (free)
   - Create a USSD channel (shared code like `*384*` + a channel)
   - Get API key from Settings → API Key
   - **Note:** Sandbox is free for development/testing. Production USSD has costs.

2. **MTN MoMo sandbox** — https://momodeveloper.mtn.com
   - Sign up
   - Subscribe to both products: "Get Paid" (Collection) and "Pay" (Disbursement)
   - Generate sandbox credentials via sandbox provisioning for both products

### Production USSD (when ready to launch)

Africa's Talking sandbox is free, but production USSD in Ghana requires a paid provider:

| Provider | Shared USSD | Dedicated USSD | Contact |
|----------|-------------|----------------|---------|
| BMS Africa (mNotify) | GHS 639.87/month | GHS 2,000/month + GHS 9,318 setup | support@mnotify.com |
| Africa's Talking Ghana | Contact for pricing | Contact for pricing | commercials@africastalking.com |

**Recommendation:** Build MVP against free sandbox. Only pay for production USSD when you have real users.

## Project Structure

```
sikalock/
├── docker-compose.yml
├── Dockerfile
├── .dockerignore
├── .env.example
├── package.json
├── src/
│   ├── server.js              # Express entry, mounts routes
│   ├── config.js              # Reads env vars
│   ├── routes/
│   │   ├── ussd.js            # POST /ussd — Africa's Talking callback
│   │   └── webhook.js         # POST /webhook/momo — MoMo payment notifications
│   ├── services/
│   │   ├── momo.js            # MoMo Collection + Disbursement calls
│   │   └── escrow.js          # Escrow state machine (lock → ship → confirm → release)
│   ├── db/
│   │   ├── pool.js            # PostgreSQL connection pool (pg library)
│   │   └── schema.sql         # Tables: users, transactions, escrow_ledger
│   └── middleware/
│       └── validate.js        # Input validation for USSD + webhook payloads
```

## Database Schema (PostgreSQL)

Three tables:

### users
| Column | Type | Notes |
|--------|------|-------|
| id | UUID | Primary key |
| phone | VARCHAR | Unique, indexed |
| name | VARCHAR | |
| role | ENUM | buyer / seller |
| created_at | TIMESTAMP | Default now() |

### transactions
| Column | Type | Notes |
|--------|------|-------|
| id | UUID | Primary key |
| buyer_id | UUID | FK → users.id |
| seller_id | UUID | FK → users.id |
| amount | DECIMAL | GHS amount |
| status | ENUM | pending / locked / shipped / released / disputed |
| momo_reference | VARCHAR | MoMo transaction ID |
| created_at | TIMESTAMP | Default now() |
| updated_at | TIMESTAMP | Updated on status change |

### escrow_ledger
| Column | Type | Notes |
|--------|------|-------|
| id | UUID | Primary key |
| transaction_id | UUID | FK → transactions.id |
| action | ENUM | fund_locked / goods_shipped / buyer_confirmed / funds_released / dispute_opened |
| timestamp | TIMESTAMP | Default now() |

## USSD Flow

```
*384*XXX#  (dial)
│
├─ 1. Register (enter name)
├─ 2. New Transaction
│     ├─ Select seller (by phone)
│     ├─ Enter amount (GHS)
│     └─ Confirm → locks funds via MoMo Collection API
├─ 3. Confirm Delivery
│     ├─ Select transaction ID
│     └─ Confirm → releases funds via MoMo Disbursement API
├─ 4. Check Status
│     └─ Enter transaction ID → shows current status
└─ 5. Dispute
      └─ Select transaction ID → flags for review
```

## MoMo Integration

- **Collection API** — `POST /collection/v1_0/requesttopay` — collect funds from buyer into escrow
- **Disbursement API** — `POST /disbursement/v1_0/transfer` — release funds to seller
- Use `mtn-momo` npm package (official MTN Node.js client)
- Sandbox credentials generated via `npx momo-sandbox`

## Docker Setup

### Dockerfile
- Node 18 alpine base
- Copy src, install deps
- Expose port 3000

### docker-compose.yml
Two services:
- `app` — builds from Dockerfile, port 3000, depends on db
- `db` — postgres:16-alpine, port 5432, volume for data persistence

Run with: `docker compose up --build`

## Environment Variables

```env
# App
PORT=3000
NODE_ENV=development

# PostgreSQL
DB_HOST=db
DB_PORT=5432
DB_NAME=sikalock
DB_USER=sikalock
DB_PASSWORD=sikalock

# Africa's Talking
AT_USERNAME=sandbox
AT_API_KEY=your_at_api_key
AT_USSD_CODE=*384*XXX#

# MTN MoMo
MOMO_ENVIRONMENT=sandbox
MOMO_CALLBACK_HOST=your_ngrok_url
MOMO_COLLECTIONS_USER_ID=generated_user_id
MOMO_COLLECTIONS_USER_SECRET=generated_user_secret
MOMO_COLLECTIONS_PRIMARY_KEY=your_primary_key
MOMO_DISBURSEMENTS_USER_ID=generated_user_id
MOMO_DISBURSEMENTS_USER_SECRET=generated_user_secret
MOMO_DISBURSEMENTS_PRIMARY_KEY=your_primary_key
```

## Local Dev Workflow

1. `docker compose up --build` — starts app + PostgreSQL
2. `ngrok http 3000` — get public URL
3. Set ngrok URL as callback in Africa's Talking dashboard + MoMo sandbox
4. Test USSD flow via Africa's Talking simulator
5. Test MoMo payments via sandbox test numbers

## MVP Scope

- USSD menu flow (register → select seller → enter amount → lock funds)
- Escrow ledger in PostgreSQL (states: pending, locked, released, disputed)
- MoMo sandbox integration (collect from buyer, disburse to seller)
- Mock delivery confirmation via USSD
- Basic transaction status endpoint

## Out of Scope (for now)

- Admin web dashboard
- Real dispute resolution workflow
- Production MoMo credentials
- SMS notifications
- Authentication/JWT (USSD sessions handle identity via phone number)

## Notes

- No traditional frontend — the "frontend" is the USSD menu on feature phones
- USSD sessions are stateless; each callback includes sessionId for tracking
- Africa's Talking simulator: https://simulator.africastalking.com:1517/
- MoMo sandbox test numbers are predefined in the sandbox docs
- **MVP uses free sandbox only** — production costs are deferred until launch

## Code Status

| Component | Status |
|-----------|--------|
| Project scaffolding | Done |
| Docker + docker-compose | Done |
| Database schema | Done |
| USSD route (5 menus) | Done |
| MoMo requestToPay (collect from buyer) | Done |
| MoMo transfer (release to seller) | Done |
| Escrow state machine | Done |
| Webhook endpoint | Done |
| Error handling (MoMo failures) | Done |
| In-memory sessions | Done (needs Redis for production) |
| Tests | Not started |

### What's left before testing

1. Fill in `.env` with Africa's Talking + MoMo sandbox credentials
2. Open Docker Desktop
3. Run `docker compose up --build`
4. Run `ngrok http 3000`
5. Set callback URLs in Africa's Talking + MoMo dashboards
