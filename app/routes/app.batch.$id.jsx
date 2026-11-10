// One printable PDF with every label in a batch (4x6 thermal).
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const loader = async ({ request, params }) => {
  const { session } = await authenticate.admin(request);
  const batch = await db.labelBatch.findUnique({ where: { id: params.id } });
  if (!batch || batch.shop !== session.shop || !batch.pdf) return new Response("Not found", { status: 404 });
  return new Response(Buffer.from(batch.pdf, "base64"), {
    headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="siluet-labels-${batch.id.slice(-6)}.pdf"` },
  });
};
