# Project log

## Standing decisions

| Date | Decision | Reason |
| --- | --- | --- |
| 2026-11-15 | Storefront-first V1 (theme app extension) | Checkout UI extension steps are Shopify Plus-only; V1 must work for all plans. |
| 2026-11-15 | Shopify App Pricing (managed pricing) | Shopify's default billing path for new public apps. No `appSubscriptionCreate` code. |
| 2026-11-15 | Public App Store distribution | Single multi-tenant backend; mandatory compliance webhooks required before launch. |
| 2026-11-15 | TypeScript kept from the official template | The React Router template is TS-only. Converting to JS would fight generated code; Blueprint §5 permits a deliberate consistent choice. |
| 2026-11-15 | Shopify Starter unsupported | Starter has no theme/storefront and is closed to new subscriptions. |

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
