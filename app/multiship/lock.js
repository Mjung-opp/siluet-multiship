// Real labels stay off until DHL has certified our shipments (Render env DHL_SHIPMENTS_CERTIFIED=1) and Mode is Live.
// Until then orders are booked by hand in MyDHL. Test labels stay on the dev store only.
// Switching to Production is an owner action on Render; nothing in the app flips it.
export const DEV_STORE = "siluet-multiship-test.myshopify.com";

export const isLocked = (settings, shop, env = process.env) =>
  shop !== DEV_STORE && (settings.dhl.env !== "live" || env.DHL_SHIPMENTS_CERTIFIED !== "1");
