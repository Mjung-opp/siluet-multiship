// Settings: sender, pickup window, DHL connection, label size, tracking page address, box sizes.
import { useLoaderData, useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import { getSettings, saveSettings } from "../multiship/settings.server.js";

const BOXES = { "CS-S": "City Silhouette Small", "CS-M": "City Silhouette Medium", "CS-L": "City Silhouette Large", GP: "City Tracks" };

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const s = await getSettings(session.shop);
  return { ...s, dhl: { ...s.dhl, apiSecret: "", hasSecret: Boolean(s.dhl.apiSecret) } };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const f = await request.formData();
  const v = (k) => String(f.get(k) ?? "").trim();
  const items = {};
  for (const key of Object.keys(BOXES)) {
    items[key] = { length: Number(v(`${key}.length`)), width: Number(v(`${key}.width`)), height: Number(v(`${key}.height`)), declaredWeightKg: Number(v(`${key}.weight`)) };
  }
  await saveSettings(session.shop, {
    sender: {
      companyName: v("companyName"), contactName: v("contactName"), phone: v("phone"), email: v("email"),
      addressLine1: v("addressLine1"), addressLine2: v("addressLine2"), city: v("city"), postalCode: v("postalCode"),
    },
    pickup: { readyTime: v("readyTime"), closeTime: v("closeTime"), location: v("location"), instructions: v("instructions") },
    dhl: { env: v("env"), apiKey: v("apiKey"), apiSecret: v("apiSecret"), accountNumber: v("accountNumber") },
    label: { template: v("template") },
    tracking: { baseUrl: v("baseUrl") },
    items,
  });
  return { saved: true };
};

function Field({ label, name, value, type = "text", help }) {
  return (
    <s-text-field label={label} name={name} defaultValue={value ?? ""} type={type} details={help} />
  );
}

export default function Settings() {
  const s = useLoaderData();
  const fetcher = useFetcher();
  return (
    <s-page heading="Settings">
      <fetcher.Form method="post">
        <s-stack gap="large">
          {fetcher.data?.saved && <s-banner tone="success" heading="Saved" />}

          <s-section heading="Sender (printed on every label)">
            <s-stack gap="base">
              <Field label="Company" name="companyName" value={s.sender.companyName} />
              <Field label="Contact name" name="contactName" value={s.sender.contactName} />
              <Field label="Phone" name="phone" value={s.sender.phone} help="With country code, e.g. +971 ..." />
              <Field label="Email" name="email" value={s.sender.email} />
              <Field label="Address line 1" name="addressLine1" value={s.sender.addressLine1} />
              <Field label="Address line 2" name="addressLine2" value={s.sender.addressLine2} />
              <Field label="City" name="city" value={s.sender.city} />
              <Field label="Postcode" name="postalCode" value={s.sender.postalCode} help="UAE has no postcodes; 00000 is accepted by DHL" />
            </s-stack>
          </s-section>

          <s-section heading="Daily DHL pickup">
            <s-stack gap="base">
              <Field label="Ready from" name="readyTime" value={s.pickup.readyTime} help="24h, e.g. 16:00" />
              <Field label="Studio closes" name="closeTime" value={s.pickup.closeTime} help="24h, e.g. 18:00" />
              <Field label="Where to collect" name="location" value={s.pickup.location} />
              <Field label="Note for the driver" name="instructions" value={s.pickup.instructions} />
            </s-stack>
          </s-section>

          <s-section heading="DHL connection (MyDHL API)">
            <s-stack gap="base">
              <s-select label="Mode" name="env" defaultValue={s.dhl.env}>
                <s-option value="test">Test (sandbox labels)</s-option>
                <s-option value="live">Live (real labels, billed)</s-option>
              </s-select>
              <Field label="DHL account number" name="accountNumber" value={s.dhl.accountNumber} />
              <Field label="API key (username)" name="apiKey" value={s.dhl.apiKey} />
              <Field label="API secret (password)" name="apiSecret" type="password" value="" help={s.dhl.hasSecret ? "Saved. Leave empty to keep it." : "Not saved yet."} />
            </s-stack>
          </s-section>

          <s-section heading="Labels and tracking">
            <s-stack gap="base">
              <s-select label="Label size" name="template" defaultValue={s.label.template}>
                <s-option value="ECOM26_A6_002">4x6 thermal (A6)</s-option>
                <s-option value="ECOM26_84_001">8x4 thermal</s-option>
                <s-option value="ECOM26_84_A4_001">A4 paper</s-option>
              </s-select>
              <Field label="Store address for tracking links" name="baseUrl" value={s.tracking.baseUrl} help="e.g. https://siluet.co" />
            </s-stack>
          </s-section>

          <s-section heading="Box sizes (one piece, packed)">
            <s-stack gap="base">
              {Object.entries(BOXES).map(([key, label]) => (
                <s-stack key={key} gap="small-200">
                  <s-heading>{label}</s-heading>
                  <s-stack direction="inline" gap="base">
                    <Field label="Length cm" name={`${key}.length`} value={s.items[key].length} type="number" />
                    <Field label="Width cm" name={`${key}.width`} value={s.items[key].width} type="number" />
                    <Field label="Height cm" name={`${key}.height`} value={s.items[key].height} type="number" />
                    <Field label="Weight kg" name={`${key}.weight`} value={s.items[key].declaredWeightKg} type="number" />
                  </s-stack>
                </s-stack>
              ))}
              <s-paragraph>Height is per piece: Silhouettes stack in one parcel, Tracks stack up to 3 per parcel.</s-paragraph>
            </s-stack>
          </s-section>

          <s-button type="submit" variant="primary" loading={fetcher.state !== "idle" || undefined}>Save settings</s-button>
        </s-stack>
      </fetcher.Form>
    </s-page>
  );
}
