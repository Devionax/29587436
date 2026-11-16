# Smart Upsell

A multi-tenant Shopify app that increases average order value with merchant-managed
product recommendations. V1 renders offers on **product pages and cart pages** via a
theme app extension so it works on every Shopify plan with an Online Store 2.0 theme.
A checkout-step experience is a separate, Shopify Plus-only module planned for later.

> Working name: Smart Checkout Upsell.

## Project status

**Phases 1–11 complete** (app foundation, multi-tenant data model with cross-shop
tests, Shopify catalog sync, recommendation rule management, recommendation engine,
shop settings, theme app extension + signed App Proxy storefront endpoint,
storefront add-to-cart with hidden line-item attribution, analytics ingestion with
an analytics page, Shopify-managed pricing with server-side entitlements, and
production hardening: webhook idempotency, mandatory privacy webhooks, storefront
rate limits and a health endpoint).

**Pending:** the Shopify Plus-only checkout-step extension (Phase 12) and manual
QA on a real development store (theme blocks, add-to-cart, plan changes). No
feature is considered shipped until it has run in the store.

See [PROJECT_LOG.md](PROJECT_LOG.md) for the phase history and known issues.

## Requirements

- Node.js >= 22.12 (developed on Node 24)
- A Shopify Partner account and a development store
- A Neon PostgreSQL database (or any PostgreSQL 14+ with two URLs: pooled + direct)

## Setup

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Create the database**

   In the Neon console create a project and copy both connection strings:
   - pooled (`...-pooler...`) into `DATABASE_URL`
   - direct (no `-pooler`) into `DIRECT_URL`

   Put them in `.env`. Both need `?sslmode=require`.

3. **Apply migrations**

   ```bash
   npm run db:migrate
   ```

   Use `npm run db:migrate:dev` while iterating on the schema.

4. **Link and run the app**

   ```bash
   npx shopify app dev
   ```

   The first run asks you to log in, create or select the app, and writes
   `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` into `.env` for you. It then opens a
   tunnel and the install link.

   > This repository was scaffolded from the official
   > `Shopify/shopify-app-template-react-router` rather than `shopify app init`,
   > because init requires an interactive Shopify login. `client_id` in
   > `shopify.app.toml` is therefore empty until your first `shopify app dev`.

5. **Install on the development store** from the CLI output, then open the app.

6. **Create the managed pricing plans**

   In the Partner Dashboard open **Monetization → Plans** for the app and create
   three plans with these exact handles:

   | Handle | Name | Limits in this codebase |
   | --- | --- | --- |
   | `free` | Free | 1 rule, 3 offers per rule, 7-day analytics |
   | `growth` | Growth | 10 rules, 10 offers per rule, 90-day analytics |
   | `pro` | Pro | unlimited rules, 20 offers per rule, 365-day analytics |

   Set prices and trials in the dashboard; prices never live in code. Copy the app
   handle (the slug in `admin.shopify.com/store/<store>/apps/<handle>`) into
   `SHOPIFY_APP_HANDLE` in `.env` so the app can link to Shopify's hosted plan
   selection page. Managed pricing is the billing source of truth; the app reads
   the active subscription through the Admin API and caches it (`Subscription`)
   for storefront and enforcement paths, refreshing at most hourly.

7. **Enable the storefront surface**

   ```bash
   npx shopify app deploy
   ```

   This pushes the app version, which enables the App Proxy
   (`/apps/upsell/*` → `/proxy/*`), publishes the theme extension and registers the
   webhook subscriptions, including the mandatory privacy topics. In the
   development store's theme editor, add **Upsell offers (product)** to a product
   template and **Upsell offers (cart)** to the cart template, then turn on
   recommendations under **Settings** in the app. Nothing renders on the storefront
   until both steps are done.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | `shopify app dev` (tunnel, env injection, HMR) |
| `npm run build` | Production build |
| `npm run start` | Serve a production build |
| `npm run typecheck` | React Router typegen + TypeScript |
| `npm run lint` | ESLint |
| `npm test` | Integration tests against a throwaway embedded PostgreSQL |
| `npm run db:generate` | Generate Prisma client |
| `npm run db:migrate` | Apply committed migrations (`prisma migrate deploy`) |
| `npm run db:migrate:dev` | Create/apply a migration in development |
| `npm run db:studio` | Prisma Studio |

## Structure

```
app/
  shopify.server.ts        Shopify app config: auth, sessions, afterAuth hook
  db.server.ts             Prisma client singleton
  services/
    shop.server.ts         Tenant upsert, plan detection, uninstall marking
    tenant.server.ts       Resolves the authenticated shop for admin requests
    rules.server.ts        Tenant-scoped rule CRUD (used by the admin UI)
    catalog.server.ts      Admin product search, normalization, snapshot upsert
    product-sync.server.ts Product webhook -> Admin re-fetch -> snapshot
    recommendation-engine.ts   Pure matching/ranking over rules and snapshots
    recommendations.server.ts  Loads a shop's active rules and runs the engine
    settings.server.ts     Shop display settings and validation
    proxy-auth.server.ts   App Proxy signature check and tenant resolution
    analytics.server.ts    Event ingestion, dedupe and merchant totals
    attribution.server.ts  Order marker parsing and attribution rows
    entitlement.server.ts  Managed-pricing entitlements, plan limits, enforcement
    webhook-receipts.server.ts  Webhook idempotency receipts
    privacy.server.ts      shop/redact tenant deletion
  utils/
    logger.server.ts       Structured JSON logging
    gid.ts                 Product/variant GID validation
    errors.ts              Typed service errors (including PlanLimitError)
    rule-form.server.ts    Rule form parsing and validation
    app-proxy.server.ts    App Proxy signature computation
    storefront-input.ts    Parsing of untrusted storefront context
    analytics-input.ts     Parsing of storefront analytics batches
    plans.ts               Plan catalog and Shopify plan selection URL
    rate-limit.server.ts   Best-effort fixed-window storefront limiting
  routes/
    app.tsx                Embedded layout and App Bridge nav
    app._index.tsx         Dashboard: store connection and setup progress
    app.catalog.tsx        Live catalog search and snapshot pinning
    app.rules._index.tsx   Rule list and quick actions
    app.rules.new.tsx      Create rule
    app.rules.$ruleId.tsx  Edit/duplicate/delete rule
    app.api.products.tsx   JSON product search for the rule editor
    app.analytics.tsx      Impressions, adds and attributed orders
    app.billing.tsx        Current plan, usage and Shopify plan selection link
    app.settings.tsx       Global switch, placements, heading, offer cap
    health.tsx             Public liveness/readiness probe (no tenant data)
    proxy.offers.tsx       Signed App Proxy endpoint for storefront offers
    proxy.events.tsx       Signed App Proxy endpoint for analytics events
    webhooks.app.uninstalled.tsx
    webhooks.app.scopes_update.tsx
    webhooks.products.create.tsx
    webhooks.products.update.tsx
    webhooks.products.delete.tsx
    webhooks.orders.create.tsx
    webhooks.customers.data_request.tsx
    webhooks.customers.redact.tsx
    webhooks.shop.redact.tsx
  components/
    rule-editor.tsx        Shared rule form and product picker
extensions/
  storefront-upsell/       Theme app extension: product/cart app blocks, JS, CSS
prisma/
  schema.prisma            Tenants, rules, catalog snapshots, analytics, billing
  migrations/              Committed SQL migrations
tests/
  setup/                   Embedded PostgreSQL boot, migration, env
  unit/                    Pure logic: engine, rule form, proxy signature, plans,
                           analytics input, rate limiting
  integration/             Tenant isolation, catalog, recommendations, proxy routes,
                           analytics, entitlements, webhook receipts and redaction
```

## Data model

- `Session` — Shopify session storage (access tokens live only here).
- `Shop` — tenant root, keyed by the canonical `*.myshopify.com` domain.
- `ShopSettings` — per-shop display configuration, created with the tenant.
- `RecommendationRule` + `TriggerProduct` / `RecommendedProduct` — merchant rules and
  their matching/recommended products.
- `ProductSnapshot` / `ProductVariantSnapshot` — local projection of products used in
  rules, refreshed by product webhooks, so the storefront never calls Shopify live.
- `AnalyticsEvent` — deduplicated impression/add events per shop and session.
- `OrderAttribution` — one row per tagged offer line on an order, written from the
  orders webhook; an association, not proof of incrementality.
- `Subscription`, `WebhookReceipt` — billing reconciliation and webhook
  idempotency records.

Every shop-owned table must be reachable from `Shop`; requests resolve the shop from
the verified Shopify session, never from client-supplied input.

## Privacy and data retention

Stored per shop: shop domain, name, currency and plan; display settings; recommendation
rules with product/variant GIDs; catalog snapshots of the products those rules
reference; analytics events (event type, surface, offer GIDs, a pseudonymous
per-session key and timestamps); order attribution (order GID, offer GIDs, quantity,
line subtotal and currency); the subscription cache; and webhook delivery receipts.

Not stored: customer names, emails, addresses or phone numbers, payment data, IP
addresses or user agents. Attribution is an association between an order and an
offer, never a customer profile.

Retention: uninstalling the app deletes sessions but keeps merchant configuration so a
reinstall resumes where it left off. Shopify sends `shop/redact` 48 hours after
uninstall; that handler deletes the tenant and every row it owns. Analytics are kept
until redaction — the plan's history window limits what is displayed, not what is
stored.

## Security notes

- OAuth scopes are `read_products` and `read_orders`. No write scopes are requested.
  `read_orders` exists only for order attribution, and order data is protected
  customer data: public distribution needs Shopify approval, and the handler stores
  no customer fields.
- Access tokens are stored server-side and never sent to the browser.
- Every webhook validates the Shopify HMAC signature. Handlers record the delivery
  id in `WebhookReceipt` and acknowledge a duplicate without reprocessing; a
  receipt left `RECEIVED` or `FAILED` is retried on the next delivery.
- The uninstall webhook deletes sessions. The mandatory `shop/redact` webhook
  deletes the entire tenant: settings, rules, offers, snapshots, analytics,
  attributions, subscription cache, sessions and receipts.
- `customers/data_request` and `customers/redact` are acknowledged without
  disclosure because no customer PII is stored: analytics carry a pseudonymous
  per-session key and attribution rows carry an order GID, never a customer
  identity.
- Storefront requests arrive through the App Proxy and are verified against
  Shopify's query-string HMAC; the shop comes from the signed `shop` parameter, never
  from the request body or a widget attribute.
- Analytics events are matched to offers owned by the verified shop, so a forged
  payload cannot write rows for another tenant.
- Storefront endpoints are rate limited per shop in process memory (offers
  120/min, events 60/min). This is per instance and best effort; it blunts loops and
  accidental floods, not a distributed attacker.
- Plan limits are enforced in services (`rules.server.ts` → `entitlement.server.ts`),
  not only in the UI, and the browser cannot grant itself a plan.
- `.env` is gitignored; only `.env.example` is committed.

## Platform constraints

- Checkout UI extensions (information/shipping/payment steps) require Shopify Plus.
- Theme app extension app blocks require Online Store 2.0 themes.
- Shopify Starter has no theme and is not supported.
- `read_orders` (order attribution) is protected customer data: a public app needs
  Shopify approval before order webhooks deliver real data. Until then everything
  except attribution works.
- Managed pricing plans must be created in the Partner Dashboard with the handles
  `free`, `growth` and `pro`; the app maps any unknown paid handle to Growth rather
  than guessing a higher tier.
- The three privacy webhooks are mandatory for public apps and are subscribed in
  `shopify.app.toml`.

## License

The scaffolding originates from Shopify's MIT-licensed React Router app template;
see [LICENSE.md](LICENSE.md).
