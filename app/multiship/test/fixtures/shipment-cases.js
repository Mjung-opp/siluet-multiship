// Representative orders for the certified DHL shipment request. Synthetic data only: no real
// customer, address, phone or account number appears here.
import { buildParcels } from '../../src/parcels.js';

export const SETTINGS = {
  sender: {
    companyName: 'Test Shipper LLC', contactName: 'Test Packer', phone: '+971000000000', email: 'shipper@example.com',
    addressLine1: 'Test Street 1', addressLine2: 'Test Area', city: 'Dubai', postalCode: '00000', countryCode: 'AE',
  },
  pickup: { readyTime: '16:00', closeTime: '18:00', location: 'reception', instructions: '' },
  dhl: { env: 'test', apiKey: 'unused', apiSecret: 'unused', accountNumber: '000000000' },
  label: { template: 'ECOM26_A6_002' },
  tracking: { baseUrl: 'https://test-shop.example' },
};

export const DAY = '2026-11-18';

function single(address, lines, { ddp = false, currency = 'USD' } = {}) {
  const domestic = address.countryCode === 'AE';
  return {
    type: 'single',
    recipients: [{ id: 'r1', address, lines }],
    shopCurrency: currency,
    ddpChoices: { r1: ddp },
    quotes: { r1: { id: 'r1', itemCount: 0, ddp: { available: !domestic }, internal: { productCode: domestic ? 'N' : 'P', parcels: buildParcels(lines) } } },
  };
}

const addr = (o) => ({ name: 'Test Recipient', phone: '+10000000000', address2: '', provinceCode: '', zip: '', ...o });

const domestic = single(addr({ address1: '1 Test Road', city: 'Business Bay', provinceCode: 'DU', countryCode: 'AE' }),
  [{ sku: 'MMB-DUBAI', title: 'Test Silhouette M', quantity: 1, barcode: '', unitPrice: 175 }]);

const euPlt = single(addr({ address1: 'Teststrasse 1', city: 'Berlin', zip: '10115', countryCode: 'DE' }), [
  { sku: 'SMB-BERLIN', title: 'Test Silhouette S', quantity: 1, barcode: '0000000000017', unitPrice: 135 },
  { sku: 'MGD-PARIS', title: 'Test Silhouette M', quantity: 1, barcode: '', unitPrice: 165 },
]);

const nonPlt = single(addr({ address1: 'Test Sokak 1', city: 'Istanbul', zip: '34000', countryCode: 'TR' }),
  [{ sku: 'GPIST3040LB', title: 'Test Tracks', quantity: 2, barcode: '', unitPrice: 120 }]);

const usDdp = single(addr({ address1: '1 Test Ave', address2: 'Apt 1', city: 'New York', provinceCode: 'NY', zip: '10001', countryCode: 'US' }),
  [{ sku: 'LMB-NEW YORK', title: 'Test Silhouette L', quantity: 1, barcode: '', unitPrice: 245 }], { ddp: true });

const kwOverLimit = single(addr({ address1: 'Test Block 1', city: 'Kuwait City', countryCode: 'KW' }),
  [{ sku: 'LMB-KUWAIT', title: 'Test Silhouette L', quantity: 2, barcode: '', unitPrice: 245 }]);

// Multi address plan, second recipient in Saudi Arabia with a National Address short code.
const saLines = [
  { sku: 'SMB-RIYADH', title: 'Test Silhouette S', quantity: 1, barcode: '', unitPrice: 135 },
  { sku: 'MMB-RIYADH', title: 'Test Silhouette M', quantity: 1, barcode: '', unitPrice: 165 },
];
const multiSa = {
  type: 'multi',
  recipients: [
    { id: 'r1', address: addr({ address1: '1 Test Road', city: 'Dubai', provinceCode: 'DU', countryCode: 'AE' }), lines: [{ sku: 'SMB-DUBAI', quantity: 1, barcode: '', unitPrice: 135 }] },
    { id: 'r2', address: addr({ address1: 'Test Street 2', address2: 'Test District, ABCD1234', city: 'Riyadh', zip: '12211', countryCode: 'SA' }), lines: saLines },
  ],
  shopCurrency: 'USD',
  ddpChoices: { r2: false },
  quotes: {
    r1: { id: 'r1', ddp: null, internal: { productCode: 'N', parcels: buildParcels([{ sku: 'SMB-DUBAI', quantity: 1 }]) } },
    r2: { id: 'r2', ddp: { available: true }, internal: { productCode: 'P', parcels: buildParcels(saLines) } },
  },
};

export const CASES = {
  'domestic-single-package': { orderName: '#9001', plan: domestic, recipient: domestic.recipients[0], letter: 'A' },
  'eu-plt': { orderName: '#9002', plan: euPlt, recipient: euPlt.recipients[0], letter: 'A' },
  'non-plt-international': { orderName: '#9003', plan: nonPlt, recipient: nonPlt.recipients[0], letter: 'A' },
  'us-ddp': { orderName: '#9004', plan: usDdp, recipient: usDdp.recipients[0], letter: 'A' },
  'kw-over-plt-limit': { orderName: '#9005', plan: kwOverLimit, recipient: kwOverLimit.recipients[0], letter: 'A' },
  'multi-sa-short-address': { orderName: '#9006', plan: multiSa, recipient: multiSa.recipients[1], letter: 'B' },
};
