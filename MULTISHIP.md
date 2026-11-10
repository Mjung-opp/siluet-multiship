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
