// Storefront: POST /apps/multiship/quote (Shopify app proxy)
import { authenticate } from "../shopify.server";
import { getSettings } from "../multiship/settings.server.js";
import { parseRequest, quote, publicQuote, InputError } from "../multiship/server.js";

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.public.appProxy(request);
  if (!admin) return Response.json({ error: "App not installed" }, { status: 401 });

  try {
    const parsed = parseRequest(await request.json());
    const { result } = await quote(admin, parsed, await getSettings(session.shop));
    return Response.json(publicQuote(result));
  } catch (e) {
    if (e instanceof InputError) return Response.json({ error: e.message }, { status: 400 });
    console.error("[multiship] quote failed", e.message, e.dhl ? JSON.stringify(e.dhl) : "");
    return Response.json({ error: "We could not reach DHL right now. Please try again in a moment." }, { status: 502 });
  }
};

export const loader = () => new Response("Method not allowed", { status: 405 });
