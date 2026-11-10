#!/bin/zsh
# End to end through the real storefront and app proxy on the dev store.
set -e
S=https://siluet-multiship-test.myshopify.com
J=$(mktemp)
PW="$(grep '^SHOPIFY_FLAG_STORE_PASSWORD=' ~/siluet-multiship/.env | cut -d= -f2- | sed "s/^'//;s/'$//;s/^\"//;s/\"$//")"
curl -s -c $J -b $J -o /dev/null "$S/password"
curl -s -c $J -b $J -o /dev/null -X POST "$S/password" --data-urlencode "form_type=storefront_password" --data-urlencode "utf8=✓" --data-urlencode "password=$PW"
echo "home: $(curl -s -c $J -b $J -o /dev/null -w '%{http_code} %{url_effective}' -L $S/)"
curl -s -c $J -b $J -X POST "$S/cart/add.js" -H 'Content-Type: application/json' \
  -d '{"items":[{"id":50959600812130,"quantity":1},{"id":50959601008738,"quantity":2},{"id":50959601107042,"quantity":2}]}' | head -c 120; echo
BODY='{"currency":"USD","rate":1,"ddp":{"r2":true},"recipients":[
 {"id":"r1","address":{"name":"Ana Silva","address1":"1 Sheikh Zayed Rd","city":"Dubai","countryCode":"AE","phone":"+971500000000"},"lines":[{"variantId":"50959601107042","quantity":2}]},
 {"id":"r2","address":{"name":"Tom Hart","address1":"10 Downing St","city":"London","zip":"SW1A 2AA","countryCode":"GB"},"lines":[{"variantId":"50959600812130","quantity":1},{"variantId":"50959601008738","quantity":1}]},
 {"id":"r3","address":{"name":"Joe Bloggs","address1":"350 5th Ave","city":"New York","zip":"10118","provinceCode":"NY","countryCode":"US"},"lines":[{"variantId":"50959601008738","quantity":1}]}]}'
echo "--- quote"
curl -s -c $J -b $J -X POST "$S/apps/multiship/quote" -H 'Content-Type: application/json' -d "$BODY" | head -c 1200; echo
echo "--- checkout"
curl -s -c $J -b $J -X POST "$S/apps/multiship/checkout" -H 'Content-Type: application/json' -d "$BODY" | head -c 400; echo
rm -f $J
