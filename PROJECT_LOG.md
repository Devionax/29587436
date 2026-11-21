# Project log

## Standing decisions

| Date | Decision | Reason |
| --- | --- | --- |
| 2026-11-15 | Storefront-first V1 (theme app extension) | Checkout UI extension steps are Shopify Plus-only; V1 must work for all plans. |
| 2026-11-15 | Shopify App Pricing (managed pricing) | Shopify's default billing path for new public apps. No `appSubscriptionCreate` code. |
| 2026-11-15 | Public App Store distribution | Single multi-tenant backend; mandatory compliance webhooks required before launch. |
| 2026-11-15 | TypeScript kept from the official template | The React Router template is TS-only. Converting to JS would fight generated code; Blueprint §5 permits a deliberate consistent choice. |
| 2026-11-15 | Shopify Starter unsupported | Starter has no theme/storefront and is closed to new subscriptions. |
| 2026-11-16 | Upsellora supports all Shopify subscription plans | Main business requirement. Product- and cart-page offers ship as a theme app extension on every plan; only the checkout carousel stays Plus-only because Shopify restricts pre-purchase checkout extensions to Plus. |
| 2026-11-16 | Offers are modeled as sources on `RecommendationRule` | Approved evolution of the existing rule model: one offers system, engine and admin experience on every plan, with manual and automatic sources. |

## Phase 1 — App foundation (complete)

**Goal:** installable, authenticated, multi-tenant app running against Neon Postgres.

### Completed

- Pulled the official `Shopify/shopify-app-template-react-router` (CLI 5.0.1 refused
  non-interactive `app init`, which requires an interactive Shopify login).
  Removed the template's git history and repo-maintenance files; initialized a fresh
  repository.
- Installed dependencies (796 packages). React Router 7.18.2,
  `@shopify/shopify-app-react-router` 3.0.1, Prisma 6.19.3, Admin API `2026-10`.
- Switched Prisma from SQLite to PostgreSQL with `DATABASE_URL` (pooled) and
  `DIRECT_URL` (direct, used by migrations).
- Added `Shop` (tenant root, plan + Plus flag, install lifecycle) and `ShopSettings`
  models; added indexes on `Session.shop`, `Session.expires`, `Shop.shopDomain`.
- Generated the initial migration
  `prisma/migrations/20261115210000_init/migration.sql`.
- Implemented installation flow:
  - `app/shopify.server.ts` `hooks.afterAuth` creates/refreshes the tenant row.
  - `app/services/shop.server.ts` reads `shop { name myshopifyDomain currencyCode plan { publicDisplayName shopifyPlus } }`.
  - `app/services/tenant.server.ts` resolves the tenant from the verified session and
    self-heals if the row is missing or stale.
- `app/uninstalled` webhook now deletes sessions and marks the tenant `UNINSTALLED`
  (data retained for the Phase 11 retention policy).
- Replaced the template demo dashboard (which created products and required
  `write_products`) with a real store-status page. Scopes reduced to `read_products`.
- Added `.env.example` with the source of every variable, a placeholder `.env`, and
  fixed `.gitignore` so `.env.example` and the lockfile are tracked.
- Added structured JSON logging (`LOG_LEVEL`).
- Added `shopify.web.toml`, a single-job CI workflow, and project README.

### Verification run

| Check | Result |
| --- | --- |
| `npx prisma validate` | pass |
| `npx prisma generate` | pass |
| `npm run typecheck` | pass |
| `npm run lint` | pass (0 errors) |
| `npm run build` | pass (client + SSR) |

### Not verified (requires the developer's accounts)

- Live OAuth install on a development store.
- `prisma migrate deploy` against the real Neon database.
- `shopify app dev` tunnel and embedded admin rendering.

`shopify app init` could not create/link the app non-interactively, so
`shopify.app.toml` still has an empty `client_id`; the first `shopify app dev`
completes linking.

### Known issues / debt

- `app/routes/webhooks.products.update.tsx` and the `[events]` block in
  `shopify.app.toml` were template placeholders. Replaced by real catalog sync in
  Phase 3.
- Compliance webhooks (`customers/data_request`, `customers/redact`, `shop/redact`)
  are commented out in `shopify.app.toml`. Required before App Store submission
  (Phase 11).
- `@shopify/polaris-types` 1.0.1 omits App Bridge's `s-app-nav`; a local JSX
  declaration was added in `app/globals.d.ts`.

## Phase 2 — Multi-tenant data model and isolation (complete)

**Goal:** every shop-owned row is scoped to the authenticated shop, enforced in one
data-access layer and proven by cross-shop tests.

### Completed

- Full V1 schema in `prisma/schema.prisma`:
  - `RecommendationRule` (status, priority, match mode, heading, offer cap, per-surface
    toggles), `TriggerProduct`, `RecommendedProduct`.
  - `ProductSnapshot` / `ProductVariantSnapshot` (local projection used by the
    storefront so offers never read Shopify live).
  - `AnalyticsEvent` (with `dedupeKey @unique`), `OrderAttribution`,
    `Subscription`, `WebhookReceipt`.
  - Enums: `RuleStatus`, `MatchMode`, `Surface`, `AnalyticsEventType`,
    `SubscriptionStatus`, `WebhookStatus`.
- Migration `20261115233000_phase2_tenant_model` generated with
  `prisma migrate diff --from-schema-datamodel / --to-schema-datamodel`, so the SQL is
  reviewable without a live database.
- `app/services/rules.server.ts`: tenant-scoped rule CRUD. The shop id is always the
  first argument, every read uses `findFirst({ id, shopId })`, child rows are stamped
  with `shopId`, and writes copy explicit fields (no request-body spread).
  `duplicateRule` always creates a `DRAFT` copy.
- `app/utils/errors.ts`: `TenantResourceNotFoundError`, `InvalidInputError`.
- Test harness running real PostgreSQL without Docker or shared credentials:
  - `embedded-postgres` 18.6.0-beta.19 on port 55432, database `scu_test`, data in
    `.tmp/pgdata` (git-ignored, deleted on stop).
  - `tests/setup/test-database.ts` boots the cluster through the Prisma CLI
    (`node node_modules/prisma/build/index.js migrate deploy`); avoids `npx.cmd`
    spawn failures on Windows.
  - `vitest.config.ts` runs files sequentially because they share one cluster;
    `teardownTimeout` raised to 90s because aborting the cluster shutdown on Windows
    left a stray server holding the port and shared memory.
- `tests/integration/tenant-isolation.test.ts` — 11 tests:
  shop stamping on children; list isolation; cross-shop read/update/delete/duplicate
  all rejected; forged `shopId` in input ignored; duplicate offer rejected inside one
  rule; analytics dedupe and count isolation; the same product GID allowed in two
  shops but not twice in one; variant uniqueness; shop deletion cascades rules,
  triggers, offers, snapshots and settings.
- CI (`.github/workflows/ci.yml`) now runs generate → validate → lint → typecheck →
  test → build.

### Verification run

| Check | Result |
| --- | --- |
| `npm test` | pass (11/11 isolation tests) |
| `npm run typecheck` | pass |
| `npm run lint` | pass |
| `npm run build` | pass |

## Phase 3 — Shopify catalog integration (complete)

**Goal:** the merchant can search their real Shopify catalog and pin trustworthy
product/variant data for storefront rendering.

### Completed

- `app/utils/gid.ts`: strict `gid://shopify/Product/...` and
  `gid://shopify/ProductVariant/...` validation.
- `app/services/catalog.server.ts`:
  - `searchProducts` (Admin GraphQL, `first` clamped 1–50, cursor pagination,
    title/variant/price fields) and `fetchProduct`.
  - `normalizeProduct` derives product availability from variant availability and
    tolerates missing image or price range.
  - `upsertProductSnapshot` writes product + variants in one transaction and replaces
    variant rows, so repeated syncs are idempotent.
  - `syncProductByGid` re-reads Shopify, writes the snapshot, and deletes the local
    snapshot when the product is gone.
- `app/services/product-sync.server.ts`: `products/create|update|delete` webhook
  handling. The webhook payload is used only to identify the product; the data is
  re-fetched through the Admin API rather than trusted from the payload. Failures
  return 500 so Shopify retries.
- Routes: `webhooks.products.create.tsx`, `webhooks.products.update.tsx`,
  `webhooks.products.delete.tsx`; `shopify.app.toml` now subscribes to those topics
  (template `[events]` block removed).
- `app/routes/app.catalog.tsx` + nav entry: live catalog search, status and saved
  badges, per-product "save/refresh snapshot" action via `useFetcher` with loading
  state, app-bridge toast, cursor pagination, and a banner instead of a crash when
  Shopify is unreachable.
- `tests/integration/catalog.test.ts` — 12 tests: field/variant normalization,
  availability derivation, missing image/price tolerance, page-size clamping,
  GraphQL error propagation, missing product, snapshot idempotency, per-shop
  separation of the same product, shop-scoped deletion, snapshot removal when the
  product disappears, and live sync writing product plus variants.

### Verification run

| Check | Result |
| --- | --- |
| `npm test` | pass (23 tests: 11 isolation + 12 catalog) |
| `npm run typecheck` | pass |
| `npm run lint` | pass |
| `npm run build` | pass |

### Not verified (requires the developer's accounts)

- Real Admin API catalog search inside the embedded admin (needs `shopify app dev`
  against a development store).
- Product webhook delivery and payload shape on the live app.

### Next: Phase 4 — Recommendation rule management UI

Rule list with filters, create/edit/duplicate/pause/delete, product and variant
picker reusing the catalog search, priority and quantity/surface controls, snapshot
of trigger/offer products on save, and empty/error states.

## Phase 4 — Rule management UI (complete)

**Goal:** a merchant can create and maintain rules end to end without touching the
database, and the stored products are pinned to Shopify data on save.

### Completed

- `app/services/rules.server.ts`: added `setRuleStatus` (scoped `updateMany`) so
  pause/activate never rewrites trigger or offer rows.
- `app/utils/rule-form.server.ts`: server-side parser/validator for the rule editor.
  Validates name/description/heading length, status and match-mode enums, priority
  range, offer cap, at least one placement, at least one trigger and one offer,
  product/variant GID format, quantity ordering (`1 ≤ min ≤ default ≤ max ≤ 100`),
  and caps of 50 triggers / 20 offers. Nothing from the form is trusted as shop
  identity.
- `app/components/rule-editor.tsx`: shared create/edit form built from Polaris web
  components. Controlled text/number/select/checkbox fields, status and match-mode
  selects, per-placement toggles, trigger list with "any variant" support, offer
  list with min/default/max quantity controls, and an inline live product picker
  with variant choice (triggers and offers use the same picker).
- `app/routes/app.api.products.tsx`: authenticated JSON search endpoint used by the
  picker; returns normalized catalog products and a safe error shape.
- `app/routes/app.rules._index.tsx`: rules list with status/priority badges, trigger
  and offer counts, placement summary, edit link, activate/pause, duplicate and
  delete (confirmed), pending states, error banner, empty state, and a success toast
  fired only after the action returns.
- `app/routes/app.rules.new.tsx` / `app.rules.$ruleId.tsx`: create and edit pages.
  The edit loader snapshots any missing referenced products (bounded to 20) so
  stored rules show titles/images; the action re-validates, writes, then refreshes
  snapshots without blocking the save on a Shopify failure. 404 when a rule id does
  not belong to the shop.
- `app/services/catalog.server.ts`: added `loadSnapshotViews` and
  `ensureProductSnapshots`.
- Dashboard now shows real saved-product and rule counts and correctly labels the
  storefront block and billing as pending.
- Tests: `tests/unit/rule-form.test.ts` (11 cases) and two new isolation tests for
  `setRuleStatus` (cross-shop rejection; status change preserves children).

### Verification run

| Check | Result |
| --- | --- |
| `npm test` | pass (36 tests: 13 isolation, 12 catalog, 11 rule-form) |
| `npm run typecheck` | pass |
| `npm run lint` | pass |
| `npm run build` | pass |

### Not verified (requires the developer's accounts)

- Manual walkthrough of the rules UI inside the embedded admin on a development
  store (`shopify app dev`), including the product picker against live Admin API.

### Known gaps

- Rule list has no search/filter or pagination yet; it renders all rules ordered by
  priority. Add when a shop can plausibly exceed one screen of rules.
- Product picker returns the first 20 matches per search with no "load more" control.

### Next: Phase 5 — Recommendation engine

Pure, testable matching and ranking: trigger matching (ANY/ALL, variant
specificity), eligibility filtering (status, placement, snapshot availability,
already-in-cart, duplicate offers), deterministic ordering (priority, position,
rule id), offer cap, and reason codes for excluded offers.

## Phase 5 — Recommendation engine and shop settings (complete)

**Goal:** deterministic, dependency-free offer selection over merchant rules plus
the shop-level switch and display settings the storefront needs.

### Completed

- `app/services/recommendation-engine.ts`: pure engine. No database, no Shopify
  calls, no price math — it takes rules, product snapshots and cart context and
  returns offers plus per-offer exclusion reasons.
  - Trigger matching: ANY / ALL, product-level and variant-specific triggers.
  - Filtering: inactive rule, surface disabled, no trigger match, inactive offer,
    missing snapshot, non-active product, missing/unavailable variant, already in
    cart, duplicate variant across rules, per-rule cap and global limit.
  - Deterministic order: `priority ASC` → rule id → offer `position` → offer id.
    First qualifying rule/offer for a variant wins.
  - Heading: first rule heading, then shop default, then a static fallback.
- `app/services/recommendations.server.ts`: loads the shop's active rules and only
  the snapshots those offers reference, maps Decimal(12,2) money to fixed 2-decimal
  strings, and runs the engine. Returns `enabled: false` (no queries beyond
  settings) until the merchant turns recommendations on.
- `app/services/settings.server.ts` + `app/routes/app.settings.tsx`: global
  enable switch, product-page/cart-page placement switches, default heading and
  maximum offers (1–10). Explicit-field writes; validation rejects an empty heading
  fallback and disabling both placements. Settings are upserted per shop.
- `app/utils/storefront-input.ts`: parses untrusted storefront context. Cart lines
  are relevance hints only (validated GIDs, integer quantities, 50-line cap);
  malformed input is dropped, never thrown. Surface names are mapped to enum values.
- Tests: `tests/unit/recommendation-engine.test.ts` (13 cases covering matching,
  ordering, caps and every filtering rule) and
  `tests/integration/recommendations.test.ts` (10 cases against real Postgres:
  disabled by default, snapshot-backed offers, shop cap, surface toggle, cross-shop
  isolation, paused rule, settings validation, cart/surface parsing).
- Test harness hardening: stray embedded-Postgres clusters from interrupted runs are
  killed before boot; shutdown is capped at 20s with a forced stop and data-dir
  cleanup, so the suite exits cleanly.

### Verification run

| Check | Result |
| --- | --- |
| `npm test` | pass (59 tests across 5 files, run twice) |
| `npm run typecheck` | pass |
| `npm run lint` | pass |
| `npm run build` | pass |

### Not verified (requires the developer's accounts)

- No storefront exists yet, so engine output has not been viewed in a browser. The
  settings page has not been walked through inside the embedded admin.

### Next: Phase 6 — Theme app extension and app proxy

Theme app extension blocks for product pages and cart page/drawer, offer card
markup, storefront JS/CSS, and a signed App Proxy endpoint that resolves the shop
from Shopify's HMAC rather than from the request body.

## Phase 6 — Theme app extension and app proxy (complete)

**Goal:** render merchant-managed offers on the real storefront without asking for
extra OAuth scopes, and serve them from a shop identity that Shopify has signed.

### Completed

- `shopify.app.toml`: `[app_proxy]` block (`url = "/proxy"`, `prefix = "apps"`,
  `subpath = "upsell"`), so buyers reach the app at `/apps/upsell/*`. No scope
  changes; the proxy still relies on the session-free signed request.
- Theme app extension `extensions/storefront-upsell/`:
  - `shopify.extension.toml` (`type = "theme"`).
  - `blocks/product-upsell.liquid` and `blocks/cart-upsell.liquid`: OS 2.0 app
    blocks (`"target": "content"`), each rendering `<upsell-offers>` with
    `data-endpoint="/apps/upsell/offers"`, the surface, the current product/product
    variant on product pages, and the merchant's optional heading override.
  - `assets/upsell.js`: dependency-free custom element. Reads the cart from
    `/cart.js`, POSTs add-to-cart to `/cart/add.js` with product/variant IDs only,
    re-reads the cart after a confirmed add, and shows the price only when the
    buyer's presentment currency matches the shop currency stored on the snapshot.
    It never computes prices or totals client-side, never trusts server data as
    HTML (DOM is built with `textContent`), and falls back to a placeholder in the
    theme editor's design mode.
  - `assets/upsell.css`: scoped `.scu-upsell*` styles.
- `app/utils/app-proxy.server.ts`: App Proxy signature verification — sorted
  `key=value` pairs concatenated with no separator, repeated values joined with
  commas, `signature` excluded, HMAC-SHA256 hex, compared with
  `crypto.timingSafeEqual`.
- `app/routes/proxy.offers.tsx` (`GET /proxy/offers`): verifies the signature,
  resolves the shop from the signed `shop` parameter (never the body), requires an
  `INSTALLED` shop, validates the surface and cart hints, calls the engine and
  returns only public offer fields. Rule names, priorities and exclusion reasons
  stay server-side. Responses are `Cache-Control: no-store`; misconfiguration is a
  503, a bad signature 401, an unknown/uninstalled shop 404.
- Engine and recommendation service now carry `currencyCode` so the storefront can
  decide whether a price is displayable in the buyer's currency.
- Tests: `tests/unit/app-proxy.test.ts` (7 cases, signature verified against an
  independently computed HMAC) and `tests/integration/proxy-offers.test.ts` (10
  cases: signed 200 with public fields only, tampered and unsigned 401, missing shop
  400, unknown and uninstalled shop 404, invalid surface 400, disabled shop,
  disabled surface, missing secret 503).

### Verification run

| Check | Result |
| --- | --- |
| `npm test` | pass (76 tests across 7 files) |
| `npm run typecheck` | pass |
| `npm run lint` | pass |
| `npm run build` | pass |

### Not verified (requires the developer's accounts and a theme)

- App blocks have not been added to a theme in the editor. Until the merchant adds
  "Upsell offers (product)" / "Upsell offers (cart)" to an Online Store 2.0 theme,
  nothing renders on the storefront.
- The app proxy must be enabled for the app version (`shopify app deploy`) before
  `/apps/upsell/offers` resolves on a dev store; this needs the CLI login.
- Cart-drawer themes render the cart block outside the cart page; drawer-specific
  refresh behaviour has not been exercised.

### Next: Phases 7–8 — Storefront wiring and add-to-cart attribution

Tighten the storefront runtime (section refresh, error states, duplicate-add
protection), attach an attribution marker to cart lines so orders can be credited
later, and confirm add-to-cart against Shopify's response before any success UI.

## Phases 7–8 — Storefront wiring and add-to-cart attribution (complete)

**Goal:** make the storefront widget behave correctly around a real cart and leave a
per-line trail that order attribution can read later.

### Completed

- Add-to-cart now sends line item properties
  (`_scu_rule`, `_scu_offer`, `_scu_surface`, `_scu_session`). Properties prefixed
  with an underscore are hidden from the buyer at checkout but remain on the order's
  line items, so attribution does not need a customer-visible field.
- Success is reported only after `/cart/add.js` returns OK; the response body is
  parsed, `422` descriptions are surfaced, and a rejected add re-enables the button.
- Duplicate-add protection: one in-flight add per variant plus a permanently
  disabled button and quantity field after success. A variant added by the widget is
  filtered out of later offer requests because the engine drops anything already in
  the cart.
- Network failures show a retry message instead of a silent failure. Quantity input
  is clamped to the offer's server-provided min/max before the request.
- Empty or disabled responses now clear and hide the region, so a stale block does
  not survive a disabled setting or a cart with no qualifying offers.
- Quantity input IDs are unique per widget instance, so two blocks on one page keep
  valid labels.
- The `upsell:added` CustomEvent now carries `ruleId`, `offerId`, `surface` and
  quantity for theme scripts; it bubbles.
- Cart-page adds reload after a confirmed add because cart totals and line markup
  belong to the theme. Product-page adds keep the card in an "Added" state and link
  to the cart.

### Verification run

| Check | Result |
| --- | --- |
| `node --check extensions/storefront-upsell/assets/upsell.js` | pass |
| `npm run lint` | pass |

### Not verified (requires a browser and a dev store)

- The widget has not run in a real storefront; the theme editor and app proxy steps
  above are prerequisites. Behavior with themes that replace `/cart/add.js`
  responses or render a cart drawer is untested.

### Next: Phase 9 — Analytics ingestion and order attribution

A signed ingest endpoint for impression/click/add events with per-session dedupe,
merchant-facing totals, and an order webhook that credits lines tagged with
`_scu_offer`. Order data requires protected-customer-data access for a public app,
so the scope decision has to be explicit.

## Phase 9 — Analytics ingestion and order attribution (complete)

**Goal:** count what the storefront actually showed and add, expose honest totals to
the merchant, and credit orders that carried the hidden offer marker.

### Completed

- Shared proxy authentication (`app/services/proxy-auth.server.ts`): the offers and
  events routes now resolve the shop only from Shopify's signed `shop` parameter,
  require an `INSTALLED` tenant, and return the same JSON error shape.
- `POST /proxy/events` (`app/routes/proxy.events.tsx`): POST only, 16 KB body cap,
  JSON parsing, at most 20 events per request, `204` on success so `sendBeacon` can
  fire and forget. Errors never affect the cart.
- `app/utils/analytics-input.ts`: strict event parsing. Only the event type
  (IMPRESSION / ADD_ATTEMPT / ADD_SUCCESS / ADD_FAILURE — post-purchase types are
  rejected), surface, offer id, session key and dedupe key are read. Rule, product
  and variant identifiers are **not** taken from the client.
- `app/services/analytics.server.ts`: resolves the offer id against the verified
  shop's `RecommendedProduct` rows and drops anything unknown or foreign, so a
  forged payload cannot write analytics for another tenant. Dedupe keys are
  namespaced by shop because the unique index is global. `getAnalyticsSummary`
  returns impressions, attempts, adds, failures, add rate, attributed
  orders/units/revenue and the top accepted offers.
- Analytics page (`app/routes/app.analytics.tsx`) with a 30-day window, per-metric
  counts, top offers, attributed totals and plain-language caveats: attributed
  revenue is line subtotal, not incremental revenue, and order attribution needs
  Shopify's protected-customer-data approval.
- Order attribution: `_scu_*` line item properties (hidden from buyers at checkout)
  are read by `app/routes/webhooks.orders.create.tsx`. The handler keeps only the
  order GID, currency and tagged lines, matches the marker to an offer owned by the
  shop **and** to the same variant, and discards the rest of the payload — customer
  fields are never stored. `OrderAttribution` now allows several offers per order
  (`@@unique([orderGid, offerVariantGid])`) and stores `lineSubtotal`; migration
  `20261116000000_phase9_order_attribution` renames the column and swaps the index.
- `shopify.app.toml`: `read_orders` scope and the `orders/create` subscription,
  with comments explaining why the read scope exists and that order data is
  protected customer data.
- Tests: `tests/unit/analytics-input.test.ts` (8), `tests/integration/analytics.test.ts`
  (11), `tests/integration/proxy-events.test.ts` (8).

### Verification run

| Check | Result |
| --- | --- |
| `npm test` | pass (103 tests across 10 files) |
| `npm run typecheck` | pass |
| `npm run lint` | pass |
| `npm run build` | pass |

### Not verified (requires the developer's accounts)

- `orders/create` deliveries are not received until the store grants `read_orders`
  and, for public distribution, Shopify approves access to protected customer data
  in the Partner Dashboard. Until then the attribution section stays empty.
- Storefront events are not rate limited yet (Phase 11); a malicious client can
  inflate impressions for its own shop, which only distorts that merchant's own
  numbers. Order attribution is unaffected because it comes from Shopify.

### Next: Phase 10 — Shopify App Pricing and entitlements

Managed pricing plans, subscription reconciliation, a server-side entitlement
module, and plan limits enforced on rules, offers and analytics history.

## Phase 10 — Shopify App Pricing and entitlements (complete)

**Goal:** sell the app through Shopify-managed plans without ever calling the
Billing API, and enforce every plan limit on the server.

### Completed

- `app/utils/plans.ts`: the plan catalog — Free (1 rule, 3 offers, 7-day analytics),
  Growth (10/10/90), Pro (unlimited rules, 20 offers, 365 days). Prices and trials
  are configured only in the Partner Dashboard. `planSelectionUrl` builds Shopify's
  hosted `pricing_plans` page from `SHOPIFY_APP_HANDLE`; `appSubscriptionCreate` is
  not used anywhere.
- `app/services/entitlement.server.ts`: reads `currentAppInstallation
  .activeSubscriptions` with `pricingDetails { ... on AppRecurringPricing {
  planHandle } }`, maps the handle to a plan and caches the result in
  `Subscription`. Cached reads serve storefront and enforcement paths; Shopify is
  re-queried at most hourly, force-refreshed by the billing page, and an Admin API
  failure falls back to the cached plan instead of locking the merchant out. An
  unknown paid handle maps to Growth and logs a warning.
- Enforcement lives in the services, not the routes: `createRule` checks rule
  capacity and offer count, `updateRule` checks offer count, `setRuleStatus` checks
  active-rule capacity. `PlanLimitError` carries `RULES`, `ACTIVE_RULES` or
  `OFFERS`; the admin routes turn it into a form error with an upgrade link.
- `requireShopContext` refreshes entitlements (TTL-bound) on every authenticated
  admin request, so plan changes in Shopify reach the app without a webhook.
- Billing page (`app/routes/app.billing.tsx`): current plan and status, rule and
  active-rule usage against limits, offer limit, "Choose a plan"/"Change plan in
  Shopify" link, and a warning when `SHOPIFY_APP_HANDLE` is missing.
- Rule list, new-rule and edit-rule screens expose the plan's offer cap; the rule
  editor refuses to add past it and links to the billing page. The analytics page
  uses the plan's history window instead of a fixed 30 days.
- Tests: `tests/unit/plans.test.ts` (4), `tests/integration/entitlement.test.ts`
  (12). `tests/helpers/db.ts` now seeds a `Subscription` for paid-plan test shops.

### Verification run

| Check | Result |
| --- | --- |
| `npm test` | pass (119 tests across 12 files) |
| `npm run typecheck` | pass |
| `npm run lint` | pass |
| `npm run build` | pass |

### Not verified (requires the developer's accounts)

- The three plans have not been created in the Partner Dashboard, so plan
  selection and the `planHandle` round-trip are untested against Shopify. Until
  they exist, every shop evaluates as Free.
- Plan changes are picked up on the next entitlement refresh (up to one hour) or
  immediately on the billing page; Shopify does not send a subscription webhook
  for managed pricing.

## Phase 11 — Production hardening and review readiness (complete)

**Goal:** make delivery safe to retry, satisfy Shopify's mandatory privacy
requirements, and bound abuse of the public storefront endpoints.

### Completed

- Webhook idempotency (`app/services/webhook-receipts.server.ts`): every handler
  records `webhookId`, topic and API version in `WebhookReceipt` before doing work.
  A `PROCESSED` receipt is acknowledged as a duplicate; `RECEIVED` (crash) and
  `FAILED` deliveries are retried with an incremented attempt count; a receipt
  write failure does not drop the webhook. Applied to all product, order, uninstall
  and scopes handlers.
- Mandatory privacy webhooks for public apps, subscribed in `shopify.app.toml`:
  - `customers/data_request` and `customers/redact` acknowledge without disclosure
    because the app stores no customer PII — analytics use a pseudonymous session
    key and attribution rows an order GID.
  - `shop/redact` calls `redactShopData` (`app/services/privacy.server.ts`): one
    transaction deletes sessions, the tenant row (cascading settings, rules,
    triggers, offers, snapshots, analytics, attributions, subscription) and webhook
    receipts. Idempotent for repeated deliveries.
- Storefront rate limiting (`app/utils/rate-limit.server.ts`): in-memory
  fixed-window counters, bounded to 10,000 keys with expiry pruning. Wired into
  both App Proxy routes after signature verification — offers 120/min/shop, events
  60/min/shop — returning `429` with `Retry-After`. Documented as best effort and
  per instance; a shared store would be needed for fleet-wide limits.
- `GET /health` (`app/routes/health.tsx`): `{ status: "ok" }` after a database
  probe, `503` when the database is unreachable, no tenant data.
- The redundant post-parse event-count check in `proxy.events.tsx` was removed;
  the parser already caps batches.
- Tests: `tests/integration/webhook-receipts.test.ts` (8 — duplicate skip, failed
  retry, crashed retry, no-id delivery, shop redaction cascade and idempotency),
  `tests/unit/rate-limit.test.ts` (5), flood tests in both proxy integration suites
  that assert `429`, and three product-webhook tests in `catalog.test.ts` (snapshot
  deletion, uninstalled-shop skip, payload GID parsing). `resolveShopId` now ignores
  product webhooks for uninstalled shops so the Admin API is not called without a
  session.
- Tests: `tests/setup/env.ts` now sets fake Shopify app credentials so modules that
  import `shopify.server.ts` can be loaded without a developer `.env`.

### Verification run

| Check | Result |
| --- | --- |
| `npm test` | pass (137 tests across 14 files) |
| `npm run typecheck` | pass |
| `npm run lint` | pass |
| `npm run build` | pass |

### Not verified (requires Shopify or a real storefront)

- Privacy webhooks have not been delivered by Shopify; they are tested through the
  service layer and route logic only. Shopify validates them after `app deploy`.
- Rate limits are per process; running several instances multiplies the effective
  limit. No shared limiter (Redis/Postgres) exists in V1.
- No load or soak test has been run against the storefront endpoints.

### App Store review checklist (state at end of Phase 11)

| Requirement | State |
| --- | --- |
| Managed pricing plans configured | Not done — Partner Dashboard |
| Mandatory privacy webhooks | Code + subscription done; needs deploy |
| Protected customer data approval (`read_orders`) | Not requested yet |
| GDPR/privacy policy and data retention description | Drafted in README; must be published with the listing |
| Theme extension renders and adds to cart | Implemented; manual dev-store QA pending |
| Order attribution receives real orders | Needs approval above |
| App listing assets, screenshots, pricing copy | Not started |

## Next: Phase 12 — Shopify Plus checkout-step extension (pending)

Adds a checkout UI extension (information/shipping/payment step) that reuses the
same backend, recommendation engine and attribution markers. It requires Shopify
Plus access: checkout UI extensions cannot be installed or tested on a non-Plus
development store. Until that access exists, this module stays unimplemented and
is clearly marked as Plus-only in the product copy; nothing else in V1 depends on
it.

After Phase 12, the remaining work is operational: create the managed pricing
plans, request protected customer data access, run manual QA in a development
store, and prepare the App Store listing. The app is not "done" until those
complete.

## All-plan pivot — A1: schema, migration, services, tests (complete)

**Goal:** prepare the data model and rule services for Upsellora's all-plan model
without changing any existing merchant-visible behavior, and prove that the
migration preserves existing data.

### Decisions

- Product- and cart-page offers stay on the theme app extension, which Shopify
  allows on every plan. Checkout stays a separate Plus-only placement; the app
  never implies checkout support on Basic, Shopify or Advanced.
- Recommendation sources become an ordered list on `RecommendationRule`
  (`MANUAL`, `RECENTLY_REMOVED`, `REPEATED_ACTIVITY`). Order is merchant priority;
  legacy rules default to `["MANUAL"]`, so their output is unchanged.
- Automatic sources need pseudonymous cart history. `CartActivity` stores only a
  storefront-generated `sessionKey`, product/variant GIDs, event type and time;
  `CartWatch` stores the last known cart lines per cart token so `carts/update`
  can be diffed (Shopify does not send the previous state).
- Checkout placement defaults to off for every rule, including existing rows.
- Schedule fields are optional; an end date must be after the start date.
- `assertActiveRuleCapacity` accepts the rule being activated so re-saving an
  already-active rule does not count itself against the plan limit.

### Schema additions (`prisma/schema.prisma`)

- Enums: `OfferSource`, `CartActivityType`.
- `RecommendationRule`: `sources OfferSource[] @default([MANUAL])`,
  `showOnCheckout Boolean @default(false)`, `autoLookbackHours Int @default(168)`,
  `autoMaxOffers Int?`, `autoMinRepeats Int @default(2)`,
  `prioritizeRepeats Boolean @default(true)`, `startsAt DateTime?`,
  `endsAt DateTime?`.
- `CartActivity` (shop-scoped, three composite indexes) and `CartWatch` (one row
  per cart token, shop-scoped, cascade on shop delete).
- `Shop` relations for both new models.

### Migration

`prisma/migrations/20261116120000_offers_sources_checkout/migration.sql` is
purely additive: two enums, eight nullable/defaulted columns, two tables, their
indexes and two cascading foreign keys. No column is dropped, renamed or retyped.

**This migration has not been applied to the developer's `DATABASE_URL`.** It was
applied only to disposable embedded PostgreSQL instances for verification. Run
`npm run db:migrate` locally after reviewing the SQL.

### Preservation evidence

Replayed the three shipped migrations into a disposable database, inserted a
legacy shop, settings, active rule, trigger, offer, analytics event, product
snapshot and subscription, then applied the new migration:

- Shop, ShopSettings, Subscription and all legacy `RecommendationRule` columns
  were byte-identical before and after.
- Trigger, offer, event and snapshot counts were unchanged.
- The legacy rule received `sources = ["MANUAL"]`, `showOnCheckout = false`,
  `autoLookbackHours = 168`, `autoMaxOffers = null`, `autoMinRepeats = 2`,
  `prioritizeRepeats = true`, `startsAt = null`, `endsAt = null`.
- `CartActivity` and `CartWatch` were created and empty.

A separate fresh database ran all four migrations with `prisma migrate deploy`
(`Database schema is up to date!`), accepted inserts into the new tables, and
`prisma migrate diff --from-migrations … --to-schema-datamodel …` produced an
empty migration (no drift).

### Services

- `app/services/placements.server.ts`: `getPlacementSupport(shop)` returns
  product page and cart page as available on every plan via the theme app
  extension, and checkout as available only when `shop.isPlus` (decided from the
  flag, not the plan name).
- `app/services/rules.server.ts`: accepts the new fields, validates non-empty
  unique sources and the schedule window, copies them on duplicate, and enforces
  active-rule capacity on create and update. Omitted fields stay unchanged so an
  older caller cannot accidentally reset sources.
- `app/services/entitlement.server.ts`: active-rule capacity can exclude the rule
  being re-saved.

### Tests added

- `tests/unit/placements.test.ts` (4): all-plan product/cart, Plus-only checkout,
  checkout keyed to `isPlus` rather than plan name.
- `tests/integration/offer-sources.test.ts` (10): defaults, ordered sources,
  automatic settings and schedule, update reorder/clear, omitted fields preserved,
  duplicate copy, empty/duplicate sources, invalid window, active capacity on
  update, tenant isolation.
- `tests/integration/cart-activity.test.ts` (4): event ordering, per-session and
  per-tenant separation, cart-watch upsert, cascade delete.

### Verification run

| Check | Result |
| --- | --- |
| `npm test` | pass (155 tests across 17 files) |
| `npm run typecheck` | pass |
| `npm run lint` | pass |
| `npm run build` | pass |
| Fresh DB `prisma migrate deploy` | pass (4 migrations) |
| `prisma migrate diff` migrations → schema | empty migration (no drift) |
| Legacy-data preservation check | pass |

### Next: A2 — Offers admin UI

Rename the Rules navigation to Offers, expose sources, schedule, automatic
settings and the plan-aware placement panel (with checkout disabled and explained
for non-Plus shops), and keep every control wired to real behavior.

The earlier "Phase 12 — Shopify Plus checkout-step extension" section is
superseded by this all-plan plan; checkout remains Plus-only and arrives in a
later phase.

---

## Admin transformation: Dashboard / Offers / Analytics / Settings

Status: implemented and verified locally. Not yet exercised against a real
development store or theme, which remains the launch gate.

### Navigation and routes

- App Bridge nav is now Dashboard (`/app`), Offers (`/app/offers`), Analytics
  (`/app/analytics`), Settings (`/app/settings`).
- New routes: `app.offers._index.tsx`, `app.offers.new.tsx`,
  `app.offers.$offerId.tsx`.
- Legacy `/app/rules`, `/app/rules/*` and `/app/catalog` redirect to the offer
  workflow so old bookmarks do not 404. The old rule editor component and rule
  pages were removed; their records are the same `RecommendationRule` rows.

### Pages

- **Dashboard**: plan-window metrics (impressions, add clicks, confirmed adds,
  attributed revenue), rates, disabled/no-active-offer banners, active offers
  table with per-offer performance, storefront checklist and plan usage asides,
  and a first-run empty state. No mock numbers: every value comes from
  `AnalyticsEvent`, `OrderAttribution`, rules and settings.
- **Offers**: searchable, status-filtered table with status, source priority,
  placements, impressions, adds, attributed revenue, and activate/pause,
  duplicate and inline delete confirmation. Plan-limit and action errors are
  surfaced in banners; upgrades link to billing. Empty state links to the
  workflow.
- **Analytics**: metric tiles for the plan window, click-through/add rates,
  failed adds, per-offer performance table, most-accepted products, and explicit
  empty states plus a note that attributed revenue depends on the orders webhook
  and protected-customer-data approval.
- **Settings**: store details, global storefront switch, default heading,
  storefront display cap (bounded by the plan), placement switches, checkout
  availability explanation, theme setup steps, plan usage. Saving is validated
  server-side; enabling neither placement is rejected.
- **Billing**: wording updated from rules to offers and per-offer product counts.

### Offer workflow

Seven steps in one form: Basics → Sources → Products → Automatic rules →
Placement → Schedule & eligibility → Review. Steps remain mounted so values
submit together; client validation jumps to the first failing step and the
server re-validates everything.

- Sources can be combined (Manual, Recently removed, Repeated activity) and
  reordered; order is the source priority the engine uses.
- Manual products come from live Shopify catalog search; each product can appear
  once, and the plan product cap is enforced in the UI, parser and service.
- Automatic settings: lookback hours, minimum repeats, optional automatic
  product cap, prioritize repeats. The UI states that automatic sources depend on
  Shopify cart webhooks and do not cover custom storefront carts.
- Scheduling stores UTC day boundaries (`startsAt` inclusive, `endsAt` inclusive
  through 23:59:59.999 UTC) and the engine filters on both.
- Checkout is never presented as an option. The placement step shows an
  informational banner: Plus-only and not implemented in this release.

### Storefront data path

- `carts/create` and `carts/update` webhooks diff the last seen cart lines per
  pseudonymous token into `CartActivity`, with cross-tenant token protection.
- `getStorefrontRecommendations` merges manual and automatic candidates in source
  priority order, excludes variants already in the cart, caps automatic
  candidates, and emits synthetic `auto:<ruleId>:<product>:<variant>` ids so
  analytics and attribution can validate rule ownership.
- Product-level duplicates are excluded by the engine and rejected by rule
  validation and the product picker.

### Tests and verification

| Check | Result |
| --- | --- |
| `npm test` | pass — 174 tests, 18 files |
| `npm run typecheck` | pass |
| `npm run lint` | pass |
| `npm run build` | pass |

New coverage added in this stage: automatic source merging/priority/dedupe and
lookback/schedule behavior (`tests/integration/auto-sources.test.ts`), real cart
webhook parsing and diffing (`tests/integration/cart-activity.test.ts`), synthetic
offer ingestion and attribution, per-offer performance aggregation
(`tests/integration/analytics.test.ts`), offer-form sources/auto/schedule/checkout
rules (`tests/unit/rule-form.test.ts`) and placement `implemented` flags
(`tests/unit/placements.test.ts`).

### Known limits / not done

- No UI verification in a browser against Shopify admin or a live theme: this
  environment has no merchant credentials. Layout uses only Polaris web
  components and passes type/build checks, but theme blocks, cart webhooks and
  plan changes still need real-store QA.
- Pre-purchase checkout carousel remains unimplemented and Plus-only; it is
  reported as unavailable rather than shown as a dead control.
- Automatic sources require Shopify cart webhooks; headless/custom carts that do
  not send them will not produce automatic candidates.
- Starter compatibility is not advertised until the theme extension is verified
  there.
- The additive migration `20261116120000_offers_sources_checkout` still has to be
  applied to the developer's `DATABASE_URL` with `npm run db:migrate`.

## Stage 3-4 — Checkout-only delivery (2026-11-17)

**Superseding decision:** upsell UI is delivered inside checkout only, per
`docs/MASTER-APP-BLUEPRINT.md` Revision 4. Product-page and cart-page offers are
not rendered; the theme app extension stays registered but frozen.

### Pre-purchase (Shopify Plus)

- `extensions/pre-purchase-upsell` — `purchase.checkout.block.render` Preact block
  with network access. Renders nothing while `src/app-origin.js` is empty.
- `/api/checkout/offers` — verifies the Shopify session token, resolves the shop
  from `dest`, rate limits, parses cart/subtotal/country hints, and evaluates
  shared rules; prices and availability come from `ProductSnapshot`.
- `/api/checkout/events` — forces `CHECKOUT` / `PRE_PURCHASE` before writing.
- Add-to-cart uses `applyCartLinesChange`; failures map to decline reasons.

### Post-purchase (access-gated)

- `extensions/post-purchase-upsell` — legacy `extend`/`render` post-purchase
  extension. `ShouldRender` asks the backend for offers and renders only when
  offers exist; accepting signs a changeset and calls `applyChangeset`; `done()`
  moves the buyer on. Any failure renders nothing or shows a message and never
  blocks the thank-you page.
- `/api/post-purchase/offers` — verifies the Shopify-issued purchase token
  (HS256, `iss: shopify`, payload under `input_data`), resolves the shop from the
  signed payload, builds the order context from `initialPurchase`, and applies
  the same rule/condition/copy engine as pre-purchase.
- `/api/post-purchase/changeset` — re-evaluates the requested offer against that
  purchase, then signs
  `{ iss: api_key, jti, iat, sub: referenceId, changes: [{type:"add_variant", variantID, quantity}] }`.
  Quantity and variant come from server-side offer data.
- `/api/post-purchase/events` — forces `CHECKOUT` / `POST_PURCHASE`.
- Analytics: `OFFER_ACCEPTED` counts as a conversion and is reported separately
  from cart adds; `OFFER_DECLINED` is reported as declined offers.

### Verification

- Request handlers live in `app/services/checkout-api.server.ts` and
  `app/services/post-purchase-api.server.ts`, so the route modules export only
  `action`. React Router strips route exports from the client build but not other
  named exports; keeping handlers in services keeps `shopify.server` server-only
  and the production build clean.
- `npm test` covers both experiences: token verification/tampering, context
  building, route auth/CORS/preflight, tenant isolation, deployment-flag gating,
  changeset claim signing, and analytics surface forcing. 28 files / 319 tests
  pass.
- `npm run typecheck`, `npm run lint` and `npm run build` pass.
- `shopify app build` bundles both extensions successfully.
- Not verifiable here: a Plus checkout, a Shopify post-purchase grant, protected
  customer data for shipping country, and order attribution. Those remain
  external approvals plus live QA.

## Stage 5 — Storefront delivery restored (2026-11-18)

**Superseding decision:** the product must show offers on the product and cart
pages, so the checkout-only decision in Revision 4 is superseded. Checkout
experiences remain; the theme app extension is active again.

### Why offers did not show

Three independent gates each blocked delivery, so fixing one alone was not enough:

1. `recommendations.server.ts` returned `enabled: false` whenever the checkout
   master switch (`ShopSettings.enabled`) was off, which is the default.
2. The settings UI had no storefront placement switches and the service ignored
   the per-shop placement flags that already existed.
3. Manual (trigger-less) offers were dropped by the engine because it required a
   trigger match, and the widget never evaluated the real cart on the product
   page.

### What changed

- **Delivery gating** — `getStorefrontRecommendations` no longer depends on the
  checkout switch. `productPageEnabled` / `cartPageEnabled` gate each surface and
  both default to true, so an installed theme block shows eligible offers
  immediately. Each rule's own `showOnProductPage` / `showOnCartPage` still
  applies. The shop offer cap (`maxOffers`) is honored as the default limit.
- **App Proxy** — `/apps/upsell/offers` verifies the query-string HMAC, resolves
  the shop from the signed `shop` parameter, rate limits 600/min per shop, and
  evaluates the cart sent by the widget. A viewed product is appended for trigger
  matching on the product page; `hasCartItems` (real cart) gates manual offers.
- **Manual / unconditional offers** — a rule with `sources: ["MANUAL"]` and no
  triggers is eligible whenever the real cart has at least one item and hidden
  on an empty cart. Covered by engine tests and a proxy test that walks the full
  eight-step sequence (empty → add A → remove A → add B → add C → remove B →
  remove C → add A).
- **Conditions** — the shared tri-state evaluator runs on storefront requests:
  product/variant membership, quantity comparisons, cart subtotal, total
  quantity, line count and logged-in state. Unknown values fail closed. Added the
  `CART_TOTAL_QUANTITY` enum value.
- **Offer wizard** — loads saved placements, triggers and conditions back into
  the editor; supports an `ANY_CART` audience (no trigger products), a flat
  condition builder with AND/OR join, and per-surface placement switches.
  Advanced/nested condition trees the flat editor cannot round-trip are shown as
  locked and left untouched on save instead of being rewritten.
- **Storefront widget** (`extensions/storefront-upsell/assets/upsell.js`) —
  tracks the cart through the Cart API, hooks `fetch`/`XMLHttpRequest` cart
  mutations and theme cart events with a 120 ms debounce and a generation guard,
  drops duplicate payloads, excludes offers already in the cart, disables sold-out
  variants, adds with `/cart/add.js` plus attribution line-item properties, and
  logs impressions. Product and cart blocks stay hidden until eligible offers
  return.
- **Settings UI** — new **Storefront placements** section with one switch per
  surface; the checkout switch is relabeled so its scope is unambiguous.
- **Free testing mode** — `DEV_TESTING_MODE=true` resolves limits to the Pro
  catalog and makes no Shopify subscription calls or writes; unset/false keeps the
  production billing path unchanged. Documented in `.env.example` and README.

### Database

- Additive migration `prisma/migrations/20261117150000_storefront_delivery`
  appends the `CART_TOTAL_QUANTITY` value to the `ConditionField` enum. No table,
  column or row is dropped or rewritten; existing condition rows are untouched.
- Applied to the throwaway test database only. **Not applied to the primary
  `DATABASE_URL`** — run `npm run db:migrate` after review to apply it.

### Verification

| Check | Result |
| --- | --- |
| `npm test` | pass — 28 files / 336 tests |
| `npm run typecheck` | pass |
| `npm run lint` | pass |
| `npm run build` | pass |
| `shopify app build` | pass — all three extensions bundle |

New/updated coverage: `tests/integration/proxy-offers.test.ts` (19 tests: HMAC,
rate limit, placements, in-cart exclusion, pause/resume, manual eight-step
sequence, condition AND cases, tenant isolation), the manual-audience block in
`tests/unit/recommendation-engine.test.ts`, the conditions block in
`tests/unit/rule-form.test.ts`, and `tests/integration/recommendations.test.ts`
rewritten for per-placement semantics.

### Known limits / not done

- No live-store verification: no merchant credentials here, so the theme blocks
  have not been exercised on a real storefront. Everything above is automated-test
  evidence; adding the blocks in the theme editor and running one real cart is
  still required.
- Cart drawers are theme-specific and are not injected into; merchants add the
  cart block to the cart page.
- Automatic sources still depend on Shopify cart webhooks.
- Pre-purchase remains Plus-only; post-purchase remains Shopify-grant-gated.

## Stage 5.1 — Checkout offer eligibility fixes (2026-11-18)

Reported symptom: after a purchase the buyer lands directly on the thank-you page
and no upsell appears.

### What was wrong

1. The post-purchase page is a separate Shopify page *before* the thank-you
   page; a buyer sent straight to thank-you means `ShouldRender` returned
   `render: false`. In this repo the most common cause is an empty
   `extensions/post-purchase-upsell/src/app-origin.js`, followed by
   `POST_PURCHASE_ENABLED` being false, checkout offers being disabled in
   Settings, or the offer not having the post-purchase experience.
2. `triggersMatch` in `app/services/checkout-offers.server.ts` returned false for
   rules without trigger products. Since the wizard now defaults new offers to
   the unconditional "any cart" audience, such an offer could be enabled for
   post-purchase and still never match. It now matches any non-empty purchase.
3. `parseRuleForm` rejected an enabled POST_PURCHASE experience whenever the
   deployment flag was off, so an offer could not be prepared for a later
   deployment. The wizard also force-disabled the checkbox in that state, which
   would have silently turned the experience off on the next save.

### What changed

- Unconditional offers are eligible in pre-purchase and post-purchase as soon as
  the purchase has at least one line.
- Post-purchase configuration is saved regardless of the deployment flag; the
  offer editor shows an informational banner that delivery starts when the
  deployment enables post-purchase, and the checkbox is no longer disabled.
  Pre-purchase keeps its hard Plus restriction.
- README documents the page order, the nine delivery prerequisites, the
  one-app-per-store selection, and the payment methods that suppress the page.

### Verification

| Check | Result |
| --- | --- |
| `npm test` | pass — 28 files / 337 tests |
| `npm run typecheck` | pass |
| `npm run lint` | pass |
| `npm run build` | pass |

### Not verified

- A real post-purchase page on a development store. `APP_ORIGIN` and
  `POST_PURCHASE_ENABLED` are deployment values that only the operator can
  supply; no merchant credentials exist here.

## Stage 5.2 — Post-purchase connectivity fix and placement retirement (2026-11-18)

Reported symptom: order `AZNEFXNEX` on `decoop-xnjjs53i.myshopify.com` went
straight to "Your order is confirmed" with no Upsellora page.

### Root cause (verified in the built bundle, not assumed)

`extensions/post-purchase-upsell/src/app-origin.js` ships an empty constant, and
`ShouldRender` returned `{ render: false }` whenever it was empty — before any
network call. The deployed bundle therefore could never show an offer, regardless
of backend state. Secondary causes fixed in Stage 5.1 (unconditional offers
rejected by `triggersMatch`, post-purchase configuration force-disabled while
the deployment flag was off) are retained.

### What changed

- The extension now reaches the backend through the App Proxy registered in
  `shopify.app.toml` (`/apps/upsell/*` -> `/proxy/*`):
  `https://{shop}/apps/upsell/post-purchase/{offers,changeset,events}`. The shop
  domain comes from `inputData.shop.domain`, falling back to the JWT payload;
  `APP_ORIGIN` remains only as an optional override that switches to
  `${APP_ORIGIN}/api/post-purchase/*`.
- The token is sent as `Authorization: Bearer` and duplicated in the JSON body,
  because proxy/CDN layers may strip headers. `authenticatePostPurchase` accepts
  a body token (bounded 8 KB JSON clone) only after the header check fails; HMAC
  verification is unchanged.
- Three App Proxy alias routes were added: `proxy.post-purchase.offers.tsx`,
  `.changeset.tsx`, `.events.tsx`.
- `ShouldRender` no longer short-circuits on a missing origin: it logs and returns
  `render: true` only after real offers are stored; it now warns explicitly for
  missing origin, non-2xx, `enabled !== true`, and an empty offer list, so a
  skipped page is explainable from the browser console.
- `Render` uses `Image source={imageUrl}`, shows product title, headline, variant,
  compare-at/price, description, CTA, and an inline error; accept posts to
  `/changeset`, then `/events`, and calls `done()`; decline only records events and
  never touches the purchase.
- The backend logs why nothing was sold: `skippedRules` (experience disabled,
  trigger miss, condition miss, invalid tree) and `rejectedOffers` (snapshot
  missing, product/variant unavailable, already in purchase, duplicate claim, cap
  reached).
- Storefront placements retired from the active workflow: rule writes force
  `showOnProductPage`/`showOnCartPage` to false, the wizard's placement step is
  replaced by a checkout-experience explanation, Settings no longer exposes the
  two switches, and defaults are false. Existing rows and columns are preserved;
  the theme extension stays on disk but delivers nothing.
- Proposed migration `20261118130000_retire_storefront_placements` only sets the
  four legacy flags to false (UPDATE only, no DDL). **Not applied to the primary
  database**; needs explicit approval, together with
  `20261117150000_storefront_delivery`.

### Verification

| Check | Result |
| --- | --- |
| `npm test` | pass — 28 files / 343 tests |
| `npm run typecheck` | pass |
| `npm run lint` | pass |
| `npm run build` | pass |
| `npx shopify app build` | pass — post-purchase bundle contains `apps/upsell/post-purchase`, and the old "set APP_ORIGIN" warning string is gone |

New coverage: five App Proxy alias tests in
`tests/integration/post-purchase-api.test.ts` (offers/changeset with a body-only
token, events through the proxy, forged body signature -> 401, CORS preflight),
plus the placement-retirement rewrite of the rule-form, recommendations and
proxy-offers suites.

### Not verified / requires operator action

- The rebuilt extension must be shipped (`shopify app dev` or
  `shopify app deploy`); the store still runs the previous bundle.
- The deployment must have `POST_PURCHASE_ENABLED=true`, plus `SHOPIFY_API_KEY`
  and `SHOPIFY_API_SECRET` for JWT verification.
- A real order on the Bogus gateway is still the only end-to-end proof; no
  merchant credentials exist here.

## Stage 5.3 — Deployment audit: why the store never saw the extension (2026-11-18)

The store still showed no post-purchase page after Stage 5.2, so the platform
layer was audited instead of the offer code. Findings, all verifiable from the
repo and the public repository state:

1. **No production deployment exists.** `shopify.app.toml` still carries the
   template placeholder `application_url = "https://shopify.dev/apps/default-app-home"`
   and a matching `redirect_urls`. There is no host configuration (no
   `vercel.json`, `render.yaml`, `fly.toml`), the Dockerfile was the only deploy
   artifact and it could not build, and no Shopify CLI login is cached on this
   machine. The admin the merchant used was a `shopify app dev` tunnel, not a
   deployed app.
2. **The published source is stale.** `origin/main` (`Devionax/29587436`) was
   last pushed 2026-11-16; the post-purchase connectivity fixes are three
   unpushed commits. Any hosting that deploys from GitHub runs the version that
   short-circuited on an empty `APP_ORIGIN`.
3. **Post-purchase preview has its own entry point.** Shopify renders local
   post-purchase extensions only through `shopify app dev` + the Shopify browser
   extension + the Dev Console link (`p` → checkout post-purchase), followed by
   a Bogus-gateway order. A normal storefront order with no dev server running
   cannot show the page; nothing has to be wrong in the code for that to happen.
4. **Zero telemetry confirms it.** The shop has no analytics rows at all, so the
   extension has never reached `ShouldRender` on this store — consistent with 1–3.

Changes made:

- `Dockerfile` rewritten as a two-stage build. The previous image ran
  `npm ci --omit=dev` and then `npm run build`, which cannot work because the
  build needs the dev dependencies; any container deploy would have failed at
  image build.
- No application code changed in this stage; the offer path was already covered
  by the 343-test suite.

Still requires the operator: a hosted URL, `shopify app deploy`, install and
selection as the store's post-purchase app — or the dev-console preview flow.

