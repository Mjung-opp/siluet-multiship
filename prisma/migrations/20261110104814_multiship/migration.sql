-- CreateTable
CREATE TABLE "MultishipCheckout" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "draftOrderId" TEXT,
    "orderId" TEXT,
    "orderName" TEXT,
    "payload" TEXT NOT NULL,
    "decResult" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "MultishipCheckout_shop_idx" ON "MultishipCheckout"("shop");
