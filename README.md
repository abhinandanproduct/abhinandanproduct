# Shree Abhinandan Product — 92.5 Silver Manufacturing ERP

A weight-accurate ERP for a Mumbai silver jewellery factory, built as a
**monorepo**: a **NestJS + Prisma** REST API and a **Next.js 15 + Tailwind**
admin dashboard. Designed around the 13-stage silver chain (CAM → Casting →
Die Number → Filing → Polish → Kacha Fitting → Magnet → Sand Blast → Plating
→ Meena → Fitting+Mala → Sticking → Packing), with per-stage loss/gain
tracking, vendor advance metal accounting, design parts, and per-piece
production variants from Plating receipt onward.

```
abhinandan_products_erp/
├── backend/    NestJS 10 · Prisma · PostgreSQL (Supabase) · JWT auth
└── frontend/   Next.js 15 (App Router) · TypeScript · TailwindCSS
                 React Hook Form + Zod · TanStack Table / Query
```

---

## Tech stack

| Layer    | Technology |
|----------|------------|
| Frontend | Next.js 15, React 18, TypeScript, TailwindCSS (silvira dark + gold theme), DM Mono, React Hook Form, Zod, TanStack Table, TanStack Query, sonner, lucide-react |
| Backend  | NestJS 10, TypeScript, Prisma ORM 5, class-validator, Passport-JWT, Multer, PDFKit |
| Database | PostgreSQL 15+ (Supabase pooler + direct) |
| Auth     | JWT (Bearer token) |
| Storage  | Local disk in dev (`backend/uploads`); Supabase Storage in production |
| Hosting  | Vercel (frontend + backend serverless) · Supabase (Postgres + Storage) |

---

## Local development

### Prerequisites
- Node.js 18+
- Postgres locally **or** a Supabase project (see below)

### 1. Backend

```bash
cd backend
npm install
cp .env.example .env          # fill in DATABASE_URL + DIRECT_URL
npx prisma generate
npx prisma migrate dev        # creates / updates schema from prisma/schema.prisma
npm run prisma:seed           # admin user, 13 processes, material categories, warehouses
npm run start:dev             # API on http://localhost:4000/api
```

### 2. Frontend

```bash
cd frontend
npm install --legacy-peer-deps
# .env.local:
#   NEXT_PUBLIC_API_URL=http://localhost:4000/api
#   NEXT_PUBLIC_FILE_BASE=http://localhost:4000
npm run dev                   # app on http://localhost:3000
```

Open **http://localhost:3000** → login **`admin` / `admin123`**.

---

## Supabase setup (production database)

1. Create a project at https://supabase.com — pick a region close to Vercel's
   default (or move both to the same region for low-latency).
2. In **Project Settings → Database**, grab:
   - **Connection pooling URL** (port 6543, pgbouncer mode `transaction`) →
     this is your `DATABASE_URL`. Append `?pgbouncer=true&connection_limit=1`.
   - **Direct connection URL** (port 5432) → this is your `DIRECT_URL`.
     Required by Prisma migrations; never used at runtime.
3. Create a public storage bucket (e.g. `uploads`) for product photos / CAD
   files / process photos.
4. Locally:
   ```bash
   cd backend
   export DATABASE_URL="postgresql://postgres.XXX:PASSWORD@...pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1"
   export DIRECT_URL="postgresql://postgres.XXX:PASSWORD@...pooler.supabase.com:5432/postgres"
   npx prisma migrate deploy   # apply existing migrations to Supabase
   npm run prisma:seed
   ```

---

## Vercel deployment

### Frontend (`/frontend`)
- Import the repo into Vercel; set **Root Directory** to `frontend`.
- Build command: `npm install --legacy-peer-deps && npm run build`
- Output directory: `.next`
- Env vars: `NEXT_PUBLIC_API_URL=https://<your-backend>.vercel.app/api`,
  `NEXT_PUBLIC_FILE_BASE=https://<bucket>.supabase.co/storage/v1/object/public/uploads`

### Backend (`/backend`)
- Import the repo into a **separate Vercel project**; set **Root Directory** to `backend`.
- Build command: `npm install && npx prisma generate && npm run build`
- Output: `dist/main.js` (handled by `backend/vercel.json`)
- Env vars: copy from `backend/.env.example` and fill production values.
  Required: `DATABASE_URL`, `DIRECT_URL`, `JWT_SECRET`, `CORS_ORIGIN`,
  `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_STORAGE_BUCKET`.
- After deploy: open the function URL once to warm it up, then run a one-off
  `prisma migrate deploy` locally pointing at production.

---

## Domain notes (read this before changing schemas)

### Identity: two codes per design
- **`sampleDesignCode`** — auto-generated at CAD entry from the CAD vendor's
  `shortName` (e.g. `TVM-001`). Internal reference used across production.
- **`itemNumber`** — sales SKU, allocated ONCE after the first Packing
  receipt (e.g. `ABN-0042`). Operator clicks "Allocate Item Number" on
  the design to bind it. Persists for the design's lifetime.

### Process chain (13 stages, all loss/gain tracked)
CAM → Casting → Die Number → Filing → Polish → Kacha Fitting → Magnet →
Sand Blast → **Plating** (bifurcates) → Meena → Fitting+Mala → Sticking →
Packing.

The sequence is per-design via `ItemProcess` rows — operators can omit
stages a design doesn't need.

### Variant bifurcation at Plating
Up to and including Plating issue, stages are tracked as a **group** (one
row, total qty + total weight). On Plating receipt, the operator weighs each
piece individually — the group splits into N `ProductionVariant` rows
(`TVM-001(1)`, `TVM-001(2)`, …) each with its own birth weight. Subsequent
stages send the variants out as a group again but receive per-piece so
loss/gain per (variant × stage) is queryable.

### BOM-capable processes
**Filing, Kacha Fitting, Fitting+Mala, Sticking** carry BOM lines on each
design (material variant + qty + weight). Sticking BOM is per-colour; the
others share a single BOM across colours. Forward auto-issues raw materials
from inventory (`MaterialIssue` voucher); receive records consumption.

### Material variants: qty AND weight
Every `MaterialVariant` can be tracked by quantity (pcs), weight (grams),
or both. `StockMovement` carries both deltas. Mandatory categories:
**Silver / Metal**, **Stone**, **Moti** — admins can add more.

### Vendor advance metal
Operators pre-allocate metal (silver / specific variant) to a vendor as an
"advance". When issuing a batch to that vendor, the form offers a choice:
**fresh metal** (debit main stock) or **from advance** (debit vendor
balance). `VendorMetalLedger` records every ALLOCATE / DRAW / RETURN /
ADJUST event with running balance.

### Audit + undo
Append-only `AuditLog`. Each domain module registers undo handlers via
`AuditService.registerUndo(strategy, handler)`. Admin can revert any
logged action; the reverse is itself logged as an `undo of #X`.

---

## Scripts

**backend**: `start:dev`, `build`, `start:prod`, `prisma:generate`,
`prisma:migrate`, `prisma:push`, `prisma:seed`, `db:setup` (push + seed),
`typecheck`

**frontend**: `dev`, `build`, `start`, `typecheck`, `lint`

---

## Architecture roadmap

| Phase | Status | Description |
|-------|--------|-------------|
| 1 — Foundation | Shipped | Postgres provider, silvira dark+gold theme, DM Mono, brand strings, 13-process master, .env templates |
| 2 — Qty + weight tracking | Shipped | Variants carry both dimensions; stock movements + material issues mirror; UI inputs added |
| 3 — Design parts + item number flow | Shipped | Parts table on Item Master + detail card; "Allocate Item Number" dialog gated on first Packing receipt |
| 4 — Vendor advance metal | Shipped | `/vendor-advances` page with allocate / return / adjust; `VendorMetalBalance` + `VendorMetalLedger`; vendor ledger feed |
| 5 — Variant bifurcation at Plating | Shipped | Plating receipts now auto-allocate one `ProductionVariant` per accepted piece. Variants persist with birth weights, are listed on the design's detail page, and queryable for per-piece weight history through subsequent stages. |
| 6 — Reports | Shipped | `/reports` with Loss/Gain · Stones · Vendor Metal · Per-Design tabs + CSV export |
| 7 — Dashboard rebuild | Shipped | Silvira layout — 4 KPI tiles, outsource strip, pipeline health (13 stage cards), metal flow, aging, top vendor holdings, recent designs |

### Phase 5 — what's live, what's a UX follow-up

**Live now:**

- Plating receive (any process with `Process.bifurcates = true`) on a
  design where `Item.bifurcationEnabled = true` automatically allocates
  one `ProductionVariant` per accepted piece — `TVM-001(1)`, `(2)` … with
  `variantIndex` running per design across all batches.
- Each variant carries a birth weight. Operators can either pass an
  explicit per-piece weights array (`perPieceWeights[]` on the receipt
  DTO) OR leave it blank and the service auto-splits the receipt's total
  weight across the N pieces.
- Variants surface on the design's detail page (Production Variants card)
  with state counts and birth weights.

**Polish that can land later (non-blocking):**

- Receive form per-piece weight inputs — currently the form sends one
  total weight per receipt row; the API already accepts `perPieceWeights`,
  the form just needs N rows on plating-receive cases.
- Forward-from-bifurcated stage variant labelling — slip PDFs can include
  the variant codes once the per-stage variant attachment lands.
- Repair flagged on a single variant — extend the receive form to capture
  `productionVariantId` per repair row, then attach to `RepairOrder`.

All three additions are additive; none of them block production use of
the variant bifurcation that's live today.
