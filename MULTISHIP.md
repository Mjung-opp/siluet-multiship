# Siluet Multiship app spec

Status: rules engine built and tested (13 tests passing). Shopify app shell not deployed yet.
Owner: Mariana. Date: 9 Nov 2026.

## Why a custom app
Qe Multiship prices each address from your normal Shopify shipping settings. It has no way to make one address free based on the others, and no API to add that. DHL Express Commerce checkout rates also see only one address at a time. So the rule has to live in our own app.

## The rules (agreed 9 Nov 2026)
1. Only for carts going to 2 or more addresses. Single address orders keep the current setup.
2. Every address is priced with DHL Express Worldwide. UAE addresses use DHL Express Domestic.
3. Free address: the one with the most items. If counts tie, the lowest DHL cost to Siluet wins. (Equal counts everywhere means the cheapest address is free.)
4. Free address shows only "Free Standard Shipping". Always free, no minimum.
5. Paid addresses show Express Worldwide only, converted to the customer's currency and rounded up to the next 5.
6. DDP is offered per international address: DHL duties and taxes estimate plus DHL's duty paid fee. Not offered inside the UAE.
7. City Lights is out of scope.

## Parcels
* City Silhouettes for one address are wrapped together. The parcel takes the footprint of the largest size and grows 3 cm in height per item. Weight is the sum of declared weights (product + box).
* City Tracks stack, max 3 per parcel. A 4th Tracks starts a second parcel. Never blocked.
* Values live in `src/config.js`. They come from the packaging sheet and must be checked against the DHL Express Commerce presets.

## How it works for the customer
1. Cart page: a "Ship to more than one address" block (theme app extension, built for mobile first).
2. The customer adds recipients and assigns items to each.
3. The app asks DHL for every address at once and shows: Free Standard Shipping on one, a price on the others, and a DDP choice where available.
4. One checkout, one payment. The app builds a Shopify draft order with all items, each item tagged with its recipient, plus one shipping line for the total. Automatic discounts (Buy 3 pay for 2) stay on.
5. After payment, Shopify keeps ONE order (decided 9 Nov 2026, so sales are never counted twice).
6. The app sends one order per address to DHL Express Commerce through its Create Orders API (reference like #1234 A, #1234 B), with the items, address, parcels, Express Worldwide or Domestic, and DDP or DAP.
7. The Shopify order is tagged `multiship`. A DHL Express Commerce rule or import filter must stop it importing as a normal single address order.
8. DHL tracking does not write back for API orders, so the app adds one Shopify fulfillment per address with its own tracking number. Each recipient's items are marked shipped separately.

## Code map
* `src/config.js` boxes, weights, HS codes, DHL product codes, labels
* `src/parcels.js` parcel builder
* `src/allocate.js` free address rule and rounding
* `src/dhl.js` MyDHL API client (rates, landed cost)
* `src/quote.js` full quote for a cart
* `test/rules.test.js` tests (`npm test`)
* `scripts/sandbox-quote.js` live check against the DHL sandbox

## Still to build
* Shopify app shell (Remix template), app proxy endpoint, cart block UI
* Draft order checkout
* Paid order webhook: push one DHL Express Commerce order per address (API key from Settings > Connect > API)
* Tracking sync back to Shopify fulfillments
* Verify the DHL Express Commerce Create Orders API fields against its docs
* Hosting (Fly.io or Render, about 5 to 25 USD a month)
* Dev store test, then uninstall Qe Multiship

## Open decisions
See the chat summary of 9 Nov 2026. Items marked VERIFY in the code need real values.

## Operations parcel service (M4, Nov 2026)

Operations (the packing app) books one DHL shipment per packed parcel through Multiship. Multiship keeps the DHL credentials, the certified request builder and the Shopify fulfilment.

**Endpoint.** `POST /internal/parcels`, server to server only. Body `{op, shop, ...}`; ops `plan`, `rates`, `create`, `status`, `label`, `reconcile` (admin actor only), `audit`. Responses are JSON; errors are `{error, code}`.

**Shops.** Only shops listed in `PARCEL_SHOPS` (comma separated, e.g. the live `….myshopify.com`) are served. Unset or empty means **no shop** (503 `shops_not_configured`): Multiship has no production shop recorded in its settings to fall back on, so it fails closed. The dev store is served only if listed.

**Signing.** Headers `X-Siluet-Timestamp` (unix seconds) and `X-Siluet-Signature` = lowercase hex HMAC-SHA256, key = UTF-8 of the env var `OPERATIONS_SERVICE_KEY`, over the string `${timestamp}.${rawBody}`. Requests more than 300 s from the server clock are refused. Without `OPERATIONS_SERVICE_KEY` every request gets 503 (fail closed). Set the same value on Render (Multiship) and in Operations; never commit it. Leading and trailing whitespace in the key is ignored on both sides. Bodies above 256 KB (bytes) are refused with 413.

**Certified data.** The parcel path builds its DHL request with the same `buildShipmentRequest` that DHL certified. Only the pieces (packed by Operations, with the customs line gross weights scaled so they add up exactly to the pieces, at least 0.001 kg per line), the references (shipment = `parcelId`, packages = `parcelId-1..N`, searchable in MyDHL), the invoice image and the commercial invoice number change.

> **Certified field changed on the parcel path: `exportDeclarations[0].invoice.number`.** The legacy batch sends `<order number>-<letter>`; the parcel path sends the `parcelId`, because several parcels of one recipient would otherwise share one invoice number. This is the one certified field the parcel path changes beyond the references and packages. **The owner should confirm this with DHL before switching to Production.** Reverting it is one line in `buildShipmentRequest` plus the test in `certified-shape.test.js`. Paperless Trade destinations get `WY`, electronic customs data and no invoice image; other destinations get no `WY`, the invoice image is returned separately by `label` and `customsPaperRequired` is set, so Operations prints the invoice copies with the label. `app/multiship/test/certified-shape.test.js` pins the certified fields; changing one fails the tests on purpose.

**Order of work.** Claim (`Parcel` row, request built once and stored; a claim that would overlap another active parcel's items is refused with `quantity_conflict` before DHL; a recipient already labelled by the old batch is refused with `legacy_label_exists`) → DHL (60 s timeout, parcel path only; the old batch keeps no timeout) → tracking and the raw DHL documents saved (`label_created`) → label PDF prepared (a PDF failure keeps the raw documents and an error, nothing is sent to Shopify) → Shopify fulfilment of exactly the packed lines with one tracking number, customer notified (`fulfilled`). A replay with the same `parcelId` never books DHL twice. A DHL call with an unknown outcome, or a claim pending for more than 120 s, becomes `needs_reconciliation`: an admin searches MyDHL for the `parcelId` and reconciles (`dhl_shipment_found` with the tracking number, or `no_dhl_shipment` once the claim is at least 180 s old, which rejects that `parcelId` for good). No pickup is booked from this path (owner answer Q6).

**Claim ordering (SQLite only).** When two packers claim the same items, the claim inserted first wins and the other gets `quantity_conflict` before DHL is called. "First" is SQLite's implicit `rowid`: SQLite has a single writer, so rowid order is commit order. The per-order lock in the code only serialises requests inside one process; across processes (several Render instances, or a restart overlap) the rowid check is what keeps two labels from being bought. **Moving Multiship to another database (e.g. Postgres) requires replacing this with a serialisable transaction or a row lock on the order.**

**Admin reconciliation procedure.** For a parcel in `needs_reconciliation`: open MyDHL, search shipments by reference for the `parcelId` (the packages carry `parcelId-1`, `parcelId-2`, ...). If a shipment exists, choose `dhl_shipment_found` and enter its waybill number (a number already used by another parcel is refused). If none exists, choose `no_dhl_shipment`; it is allowed only once the claim is at least 180 s old (`too_early` before), and the parcel is then rejected for good, so Operations packs again with a new parcel ID. The minimum can be raised with `PARCEL_NO_SHIPMENT_MIN_AGE_SECONDS` (never below 180). **Owner decision:** whether to run with a longer minimum (for example 600 s) to leave more room for a slow DHL answer; the default stays at the plan's 180 s.

**Orphan labels.** There is no void op. A late DHL answer after `no_dhl_shipment` is kept (`lateTrackingNumber`, `lateLabel`) and raises a `duplicate_shipment_suspected` alert in `audit`; the admin then voids one of the two shipments in MyDHL.

**Services.** `rates` returns DHL's services filtered to `P` and `N` (owner answer Q5). An admin can widen this later with the env var `PARCEL_ALLOWED_PRODUCT_CODES` (comma separated) or `parcel.allowedProductCodes` in the shop settings.

**Retention.** Each `audit` call removes recipient name, address and phone from stored requests 90 days after the parcel is fulfilled or rejected. Labels follow the existing `Shipment.label` practice (no retention rule yet, follow-up).

**Database.** Migrations `20261117120000_parcel_service` (adds `Parcel` and `ParcelAlert`) `20261117150000_parcel_label_documents` (adds `Parcel.labelDocuments`, the raw DHL label documents saved before any PDF work) and `20261117180000_parcel_fulfillment_id` (adds `Parcel.shopifyFulfillmentId`, so a fulfilled parcel stops holding quantity once its Shopify fulfilment is in the snapshot, even if its tracking number is later removed or edited in Shopify). It runs on boot (`npm run docker-start` → `prisma migrate deploy`). Back up the SQLite file first.

**Rollout.**
1. Confirm the Render service has a persistent disk and `DATABASE_URL` points at it (owner confirmed a 1 GB disk). Without it, claims and labels are lost on every deploy.
2. Deploy Multiship first, with `OPERATIONS_SERVICE_KEY` and `PARCEL_SHOPS` set. Then deploy Operations.
3. The parcel path stays **locked** (`create` answers 423 `locked`; `rates` keeps working) until real labels are switched on. Switching to DHL Production is an **owner action on Render**: Mode Live (`dhl.env = live`) and `DHL_SHIPMENTS_CERTIFIED=1`. The build never changes either.
4. Once Operations prints every label, set `LEGACY_BATCH_DISABLED=1` to switch off the old batch on the Orders page. The batch already skips orders that have parcels.

**Owner-run sandbox scripts** (call the DHL test API, need credentials in your shell, refuse to run without `--i-understand-this-calls-dhl` and `DHL_ENV=test`):
* `app/multiship/scripts/parcel-rates-sandbox.js` lists services with price and ETA and prints the raw ETA field.
* `app/multiship/scripts/parcel-sandbox-shipment.js` books one two-piece test shipment to the UK (Paperless Trade) and saves the documents.

**Tests.** `npm test` (fakes only; no DHL, Shopify or database calls).
