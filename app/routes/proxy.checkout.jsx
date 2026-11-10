// Storefront: POST /apps/multiship/checkout (Shopify app proxy)
// Re-quotes on the server, saves the plan, creates one draft order and returns its checkout link.
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getSettings } from "../multiship/settings.server.js";
import { parseRequest, quote, InputError } from "../multiship/server.js";

const DRAFT_CREATE = `#graphql
mutation MultishipDraft($input: DraftOrderInput!) {
  draftOrderCreate(input: $input) {
    draftOrder { id invoiceUrl }
    userErrors { field message }
  }
}`;

function mailing(a) {
  const [firstName, ...rest] = a.name.split(/\s+/);
  return {
    firstName,
    lastName: rest.join(" ") || firstName,
    address1: a.address1,
    address2: a.address2 || undefined,
    city: a.city,
    provinceCode: a.provinceCode || undefined,
    zip: a.zip || undefined,
    countryCode: a.countryCode,
    phone: a.phone || undefined,
  };
}

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.public.appProxy(request);
  if (!admin) return Response.json({ error: "App not installed" }, { status: 401 });

  try {
    const parsed = parseRequest(await request.json());
    const { result, recipients, shopCurrency } = await quote(admin, parsed, await getSettings(session.shop));
    const byId = Object.fromEntries(result.quotes.map((q) => [q.id, q]));
    const currencyCode = parsed.currency;

    // Shipping for every address in one line. DDP prepayments as their own lines, so customers see them.
    const shippingAmount = result.quotes.reduce((s, q) => s + q.shipping.amount, 0);
    const ddpLines = recipients
      .filter((r) => parsed.ddpChoices[r.id] && byId[r.id].ddp?.available)
      .map((r) => ({
        title: `Duties and taxes prepaid: ${r.address.name}`,
        quantity: 1,
        originalUnitPriceWithCurrency: { amount: byId[r.id].ddp.amount.toFixed(2), currencyCode },
        requiresShipping: false,
        taxable: false,
      }));

    const record = await db.multishipCheckout.create({
      data: {
        shop: session.shop,
        status: "draft",
        payload: JSON.stringify({
          recipients,
          shopCurrency,
          ddpChoices: parsed.ddpChoices,
          currency: currencyCode,
          rate: parsed.rate,
          quote: result,
        }),
      },
    });

    const free = recipients.find((r) => r.id === result.freeRecipientId);
    const input = {
      tags: ["multiship"],
      note: `Multi address order: ${recipients.length} addresses. Free shipping: ${free.address.name}.`,
      customAttributes: [{ key: "_multiship_id", value: record.id }],
      presentmentCurrencyCode: currencyCode,
      acceptAutomaticDiscounts: true,
      allowDiscountCodesInCheckout: true,
      shippingAddress: mailing(free.address),
      ...(parsed.email ? { email: parsed.email } : {}),
      shippingLine: {
        title: `DHL Express to ${recipients.length} addresses (1 free)`,
        priceWithCurrency: { amount: shippingAmount.toFixed(2), currencyCode },
      },
      lineItems: [
        ...recipients.flatMap((r) => r.lines.map((l) => ({
          variantId: `gid://shopify/ProductVariant/${l.variantId}`,
          quantity: l.quantity,
          customAttributes: [
            { key: "Ship to", value: `${r.address.name}, ${r.address.city}` },
            { key: "_recipient", value: r.id },
          ],
        }))),
        ...ddpLines,
      ],
    };

    const res = await admin.graphql(DRAFT_CREATE, { variables: { input } });
    const { data } = await res.json();
    const out = data.draftOrderCreate;
    if (out.userErrors?.length) {
      console.error("[multiship] draft errors", JSON.stringify(out.userErrors));
      return Response.json({ error: "We could not start checkout. Please try again." }, { status: 500 });
    }

    await db.multishipCheckout.update({
      where: { id: record.id },
      data: { draftOrderId: out.draftOrder.id },
    });

    return Response.json({ url: out.draftOrder.invoiceUrl });
  } catch (e) {
    if (e instanceof InputError) return Response.json({ error: e.message }, { status: 400 });
    console.error("[multiship] checkout failed", e.message, e.dhl ? JSON.stringify(e.dhl) : "");
    return Response.json({ error: "We could not reach DHL right now. Please try again in a moment." }, { status: 502 });
  }
};

export const loader = () => new Response("Method not allowed", { status: 405 });
