// Create a few test products on the dev store (real SKUs and prices from siluet.co). Dev store only.
const [url] = process.argv.slice(2);
const gql = async (query, variables) => {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query, variables }) });
  return r.json();
};

const products = [
  { title: "Abu Dhabi", option: "Size", value: "Large", sku: "LMB-ABU DHABI", price: "250.00" },
  { title: "Delhi", option: "Size", value: "Medium", sku: "MMB-DELHI", price: "165.00" },
  { title: "Paris Gold", option: "Size", value: "Small", sku: "SGD-PARIS", price: "135.00" },
  { title: "Abu Dhabi Grand Prix - Yas Island", option: "Frame", value: "Black Frame", sku: "GPAUH3040LB", price: "145.00" },
];

const pubs = await gql(`{ publications(first: 10) { nodes { id name } } }`);
const publicationIds = (pubs.data?.publications?.nodes || []).map((p) => ({ publicationId: p.id }));

for (const p of products) {
  const res = await gql(
    `mutation($input: ProductSetInput!) { productSet(synchronous: true, input: $input) { product { id title } userErrors { field message } } }`,
    { input: {
      title: p.title, status: "ACTIVE",
      productOptions: [{ name: p.option, values: [{ name: p.value }] }],
      variants: [{ optionValues: [{ optionName: p.option, name: p.value }], sku: p.sku, price: p.price, inventoryPolicy: "CONTINUE" }],
    } },
  );
  const prod = res.data?.productSet?.product;
  console.log(p.sku, prod ? `created ${prod.id}` : JSON.stringify(res.errors || res.data?.productSet?.userErrors));
  if (prod && publicationIds.length) {
    const pub = await gql(`mutation($id: ID!, $input: [PublicationInput!]!) { publishablePublish(id: $id, input: $input) { userErrors { message } } }`, { id: prod.id, input: publicationIds });
    if (pub.errors || pub.data?.publishablePublish?.userErrors?.length) console.log("  publish:", JSON.stringify(pub.errors || pub.data.publishablePublish.userErrors).slice(0, 200));
  }
}
