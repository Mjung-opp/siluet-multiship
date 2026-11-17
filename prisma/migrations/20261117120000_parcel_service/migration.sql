-- CreateTable
CREATE TABLE "Parcel" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderName" TEXT,
    "recipientId" TEXT NOT NULL,
    "productCode" TEXT NOT NULL,
    "quotedPrice" TEXT,
    "pieces" TEXT NOT NULL,
    "lines" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "requestJson" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "claimedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "trackingNumber" TEXT,
    "pieceTrackingNumbers" TEXT,
    "label" TEXT,
    "invoice" TEXT,
    "customsPaperRequired" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    "lateTrackingNumber" TEXT,
    "lateLabel" TEXT,
    "lateAt" DATETIME,
    "reconciledBy" TEXT,
    "reconciledAt" DATETIME,
    "closedAt" DATETIME,
    "redactedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ParcelAlert" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "parcelId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "detail" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "Parcel_shop_orderId_idx" ON "Parcel"("shop", "orderId");

-- CreateIndex
CREATE INDEX "Parcel_status_claimedAt_idx" ON "Parcel"("status", "claimedAt");

-- CreateIndex
CREATE INDEX "Parcel_trackingNumber_idx" ON "Parcel"("trackingNumber");

-- CreateIndex
CREATE INDEX "ParcelAlert_shop_createdAt_idx" ON "ParcelAlert"("shop", "createdAt");

