# Upsellora

A multi-tenant Shopify app that increases average order value with merchant-managed
product recommendations on the **product page**, in the **cart**, and **inside checkout**.

- **Product page and cart page** — a theme app extension renders the offers in
  theme blocks. The widget evaluates the real cart through the Storefront Cart
  API, recalculates after every cart change, and adds offers without duplicates.
- **Pre-purchase** — a checkout UI extension block on Shopify Plus.
- **Post-purchase** — a post-purchase extension once Shopify grants this app access.

> Package name: `smart-checkout-upsell`.

## Project status

**Production code complete for V1.** The admin uses the Upsellora structure —
Dashboard, Offers, Analytics, Settings — with a seven-step offer workflow that
combines manual product selection with automatic sources (recently removed and
repeatedly added cart products). All four delivery surfaces are implemented:

- `extensions/storefront-upsell` ships the `product-upsell` and `cart-upsell`
  theme blocks. They call `/apps/upsell/offers` through the signed App Proxy and
  read the live cart with `/cart.js`; manual (trigger-less) offers and
  condition-based offers are evaluated server-side.
- `extensions/pre-purchase-upsell` renders a `purchase.checkout.block.render` block
  and calls `/api/checkout/offers` and `/api/checkout/events` with a verified
  Shopify session token.
- `extensions/post-purchase-upsell` runs `Checkout::PostPurchase::ShouldRender`
  and `Render`, calls `/api/post-purchase/*` with the Shopify-issued purchase
  token, and applies signed changesets to the order.

**Pending external approvals and live QA:** pre-purchase needs a Shopify Plus
store; post-purchase needs Shopify to grant post-purchase access and
`POST_PURCHASE_ENABLED=true`; order attribution needs approval for protected
customer data. No feature is considered shipped until it has run in a real store.

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
   | `free` | Free | 1 offer, up to 3 products per offer, 7-day analytics |
   | `growth` | Growth | 10 offers, up to 10 products per offer, 90-day analytics |
   | `pro` | Pro | unlimited offers, up to 20 products per offer, 365-day analytics |

   Set prices and trials in the dashboard; prices never live in code. Copy the app
   handle (the slug in `admin.shopify.com/store/<store>/apps/<handle>`) into
   `SHOPIFY_APP_HANDLE` in `.env` so the app can link to Shopify's hosted plan
   selection page. Managed pricing is the billing source of truth; the app reads
   the active subscription through the Admin API and caches it (`Subscription`)
   for storefront and enforcement paths, refreshing at most hourly.

7. **Point both extensions at this deployment**

   Each extension compiles its backend origin into the bundle because Shopify
   does not proxy extension calls or inject environment variables at extension
   build time. Set `APP_ORIGIN` in both files, with no trailing slash, to the same
   origin as `SHOPIFY_APP_URL`:

   - `extensions/pre-purchase-upsell/src/app-origin.js`
   - `extensions/post-purchase-upsell/src/app-origin.js`

   While the constant is empty, each extension renders nothing and logs one
   warning; nothing breaks.

8. **Deploy the app and extensions**

   ```bash
   npx shopify app deploy
   ```

   This pushes the app version, registers the webhook subscriptions (including
   the mandatory privacy topics), the App Proxy (`/apps/upsell/*` → `/proxy/*`)
   and all three extensions (theme app extension, pre-purchase, post-purchase).

9. **Add the storefront blocks in the theme editor**

   In **Online Store → Themes → Customize**:

   - Open the **Product** template and add the **Upsell offers** block from
     "Apps" (block: `product-upsell`). Optionally set a heading override.
   - Open the **Cart** template and add the **Upsell offers (cart)** block
     (`cart-upsell`).

   The blocks stay hidden until the endpoint returns eligible offers. Whether a
   placement delivers is controlled in the app under **Settings → Storefront
   placements** (product page and cart page, both on by default). The
   "show offers in checkout" switch gates checkout only and does not affect the
   theme blocks.

   Offers appear when the offer is active, the rule's placement for that surface
   is on, its trigger/condition matches the current cart, and the merchant has a
   plan that allows it.

10. **Turn on post-purchase only after Shopify grants access**

    Post-purchase is access-gated by Shopify per app and store, and only one
    post-purchase app can be active on a store. After the grant, set
    `POST_PURCHASE_ENABLED=true` in `.env` and restart the app. The merchant can
    then enable the post-purchase experience on an offer.

## Free development and testing mode

`DEV_TESTING_MODE=true` in `.env` skips all plan enforcement so every offer
feature can be exercised without a paid plan: limits resolve to the Pro catalog
and no subscription is read from or written to Shopify. The billing
architecture is untouched — with the flag unset or `false`, the real subscription
is read and enforced exactly as in production. Never leave the flag enabled on a
live store.

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
    rules.server.ts        Tenant-scoped offer CRUD (RecommendationRule table)
    catalog.server.ts      Admin product search, normalization, snapshot upsert
    product-sync.server.ts Product webhook -> Admin re-fetch -> snapshot
    recommendation-engine.ts   Pure matching/ranking over rules and snapshots
    recommendations.server.ts  Loads active offers, merges manual + automatic sources
    cart-activity.server.ts    Cart webhook diffing for automatic sources
    placements.server.ts   Plan-aware placement support (product, cart, checkout)
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
    offer-id.ts            Synthetic ids for automatic offers
    rule-form.server.ts    Offer form parsing and validation
    app-proxy.server.ts    App Proxy signature computation
    storefront-input.ts    Parsing of untrusted storefront context
    analytics-input.ts     Parsing of storefront analytics batches
    plans.ts               Plan catalog and Shopify plan selection URL
    rate-limit.server.ts   Best-effort fixed-window storefront limiting
  routes/
    app.tsx                Embedded layout and App Bridge nav
    app._index.tsx         Dashboard: performance, active offers, setup checklist
    app.offers._index.tsx  Offer list, filters and quick actions
    app.offers.new.tsx     Create offer (seven-step workflow)
    app.offers.$offerId.tsx  Edit/duplicate/delete an offer
    app.api.products.tsx   JSON product search for the offer product picker
    app.analytics.tsx      Impressions, clicks, adds and attributed revenue
    app.billing.tsx        Current plan, usage and Shopify plan selection link
    app.settings.tsx       Storefront switches, placements, heading, offer cap
    app.rules*.tsx         Redirects for old rule bookmarks
    app.catalog.tsx        Redirect to the offer workflow
    health.tsx             Public liveness/readiness probe (no tenant data)
    proxy.offers.tsx       Signed App Proxy endpoint for storefront offers
    proxy.events.tsx       Signed App Proxy endpoint for analytics events
    webhooks.app.uninstalled.tsx
    webhooks.app.scopes_update.tsx
    webhooks.products.create.tsx
    webhooks.products.update.tsx
    webhooks.products.delete.tsx
    webhooks.orders.create.tsx
    webhooks.carts.create.tsx
    webhooks.carts.update.tsx
    webhooks.customers.data_request.tsx
    webhooks.customers.redact.tsx
    webhooks.shop.redact.tsx
  components/
    offer-wizard.tsx       Seven-step create/edit workflow
    product-picker.tsx     Catalog search and variant selection
    ui.tsx                 Metrics, empty states, badges and formatters
extensions/
  pre-purchase-upsell/     Checkout UI extension (purchase.checkout.block.render)
  post-purchase-upsell/    Post-purchase UI extension (legacy extend/render API)
  storefront-upsell/       Theme app extension: product-page and cart-page blocks,
                           Cart API widget (upsell.js), styles and locales
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
- `RecommendationRule` + `TriggerProduct` / `RecommendedProduct` — merchant offers,
  their recommendation sources, schedule and selected products.
- `CartActivity` / `CartWatch` — per-shop cart add/remove events and the last seen
  cart lines per pseudonymous cart token, used by the automatic sources.
- `ProductSnapshot` / `ProductVariantSnapshot` — local projection of products used in
  offers, refreshed by product webhooks, so the storefront never calls Shopify live.
- `AnalyticsEvent` — deduplicated impression/add events per shop and session.
- `OrderAttribution` — one row per tagged offer line on an order, written from the
  orders webhook; an association, not proof of incrementality.
- `Subscription`, `WebhookReceipt` — billing reconciliation and webhook
  idempotency records.

Every shop-owned table must be reachable from `Shop`; requests resolve the shop from
the verified Shopify session, never from client-supplied input.

## Privacy and data retention

Stored per shop: shop domain, name, currency and plan; display settings; offers
with product/variant GIDs, sources and schedules; catalog snapshots of the products
those offers reference; cart activity rows keyed by a pseudonymous cart token;
analytics events (event type, surface, offer GIDs, a pseudonymous per-session key
and timestamps); order attribution (order GID, offer GIDs, quantity, line subtotal
and currency); the subscription cache; and webhook delivery receipts.

Not stored: customer names, emails, addresses or phone numbers, payment data, IP
addresses or user agents. Attribution is an association between an order and an
offer, never a customer profile.

Retention: uninstalling the app deletes sessions but keeps merchant configuration so a
reinstall resumes where it left off. Shopify sends `shop/redact` 48 hours after
uninstall; that handler deletes the tenant and every row it owns. Analytics are kept
until redaction — the plan's history window limits what is displayed, not what is
stored.

## Security notes

- OAuth scopes are `read_products`, `read_orders` and `write_app_proxy`. The only
  write scope is used for the App Proxy storefront endpoint; no store data is
  written through the Admin API. `read_orders` exists only for order attribution,
  and order data is protected customer data: public distribution needs Shopify
  approval, and the handler stores no customer fields.
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
- Checkout extension requests are verified with Shopify's signed session token
  (pre-purchase) or purchase token (post-purchase). The shop, signed-in state and
  purchase contents come from the token, never from the request body.
- A post-purchase changeset is signed only after the requested offer is
  re-evaluated against that purchase; the variant and quantity always come from
  server-side offer data.
- Storefront requests arrive through the App Proxy and are verified against
  Shopify's query-string HMAC; the shop comes from the signed `shop` parameter, never
  from the request body or a widget attribute.
- Analytics events are matched to offers owned by the verified shop, so a forged
  payload cannot write rows for another tenant.
- Storefront and checkout endpoints are rate limited in process memory (App Proxy
  offers 600/min and events 60/min per shop; checkout offers and events 120/min per
  shop or purchase; post-purchase changeset signing 20/min per purchase). This is
  per instance and best effort; it blunts loops and accidental floods, not a
  distributed attacker.
- Plan limits are enforced in services (`rules.server.ts` → `entitlement.server.ts`),
  not only in the UI, and the browser cannot grant itself a plan.
- `.env` is gitignored; only `.env.example` is committed.

## Platform constraints

- Pre-purchase checkout extensions require Shopify Plus; the UI and backend both
  report the experience as unavailable for other plans.
- Post-purchase extensions require a Shopify grant for the app and store, and only
  one post-purchase app can be active per store. Until then the deployment keeps
  `POST_PURCHASE_ENABLED=false`.
- Checkout extensions receive shipping country only when protected customer data
  access is granted; otherwise country conditions fail closed.
- Theme app extension app blocks require Online Store 2.0 themes. Both blocks are
  added by the merchant in the theme editor; cart drawers are theme-specific and
  are not injected into.
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
