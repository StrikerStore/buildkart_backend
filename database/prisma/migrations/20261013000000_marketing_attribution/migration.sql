-- Marketing: attribution, Meta's Conversions API, sessions and ad spend.
--
-- `OrderAttribution` is where a storefront order came from (UTM tags, click
-- ids, referrer) plus the browser identifiers Meta matches server events on.
-- `MarketingEvent` is the outbound log and retry queue for those events.
-- `StorefrontSession` and `AnalyticsDaily` are the storefront's own visits and
-- their daily summary — the conversion funnel. `AdSpendDaily` is Meta's
-- Insights API, per ad per day.
--
-- All new tables, so `IF NOT EXISTS` is enough to make this re-runnable.
-- No backfill: orders written before this have no attribution to recover.

CREATE TABLE IF NOT EXISTS `OrderAttribution` (
  `orderId`       VARCHAR(191) NOT NULL,
  `channel`       VARCHAR(20) NOT NULL,
  `firstSource`   VARCHAR(100) NULL,
  `firstMedium`   VARCHAR(100) NULL,
  `firstCampaign` VARCHAR(150) NULL,
  `firstContent`  VARCHAR(150) NULL,
  `firstTerm`     VARCHAR(150) NULL,
  `firstLanding`  VARCHAR(500) NULL,
  `firstReferrer` VARCHAR(500) NULL,
  `firstAt`       DATETIME(3) NULL,
  `lastSource`    VARCHAR(100) NULL,
  `lastMedium`    VARCHAR(100) NULL,
  `lastCampaign`  VARCHAR(150) NULL,
  `lastContent`   VARCHAR(150) NULL,
  `lastTerm`      VARCHAR(150) NULL,
  `lastLanding`   VARCHAR(500) NULL,
  `lastReferrer`  VARCHAR(500) NULL,
  `lastAt`        DATETIME(3) NULL,
  `fbclid`        VARCHAR(255) NULL,
  `gclid`         VARCHAR(255) NULL,
  `fbp`           VARCHAR(100) NULL,
  `fbc`           VARCHAR(300) NULL,
  `userAgent`     VARCHAR(500) NULL,
  `ipAddress`     VARCHAR(45) NULL,
  `sessionId`     VARCHAR(64) NULL,
  `createdAt`     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `OrderAttribution_channel_createdAt_idx` (`channel`, `createdAt`),
  INDEX `OrderAttribution_lastCampaign_idx` (`lastCampaign`),
  INDEX `OrderAttribution_createdAt_idx` (`createdAt`),
  PRIMARY KEY (`orderId`),
  CONSTRAINT `OrderAttribution_orderId_fkey` FOREIGN KEY (`orderId`)
    REFERENCES `Order` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `MarketingEvent` (
  `id`        VARCHAR(191) NOT NULL,
  `platform`  VARCHAR(16) NOT NULL,
  `eventName` VARCHAR(64) NOT NULL,
  `eventId`   VARCHAR(191) NOT NULL,
  `orderId`   VARCHAR(191) NULL,
  `payload`   JSON NOT NULL,
  `status`    VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  `attempts`  INTEGER NOT NULL DEFAULT 0,
  `lastError` VARCHAR(500) NULL,
  `traceId`   VARCHAR(64) NULL,
  `isTest`    BOOLEAN NOT NULL DEFAULT false,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  `sentAt`    DATETIME(3) NULL,

  UNIQUE INDEX `MarketingEvent_eventId_key` (`eventId`),
  INDEX `MarketingEvent_status_createdAt_idx` (`status`, `createdAt`),
  INDEX `MarketingEvent_orderId_idx` (`orderId`),
  INDEX `MarketingEvent_createdAt_idx` (`createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `StorefrontSession` (
  `id`              VARCHAR(64) NOT NULL,
  `visitorId`       VARCHAR(64) NOT NULL,
  `customerId`      VARCHAR(191) NULL,
  `day`             DATE NOT NULL,
  `startedAt`       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `lastSeenAt`      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `landingPath`     VARCHAR(300) NOT NULL,
  `channel`         VARCHAR(20) NOT NULL,
  `source`          VARCHAR(100) NULL,
  `medium`          VARCHAR(100) NULL,
  `campaign`        VARCHAR(150) NULL,
  `device`          VARCHAR(10) NOT NULL,
  `isReturning`     BOOLEAN NOT NULL DEFAULT false,
  `pageViews`       INTEGER NOT NULL DEFAULT 0,
  `viewedProduct`   BOOLEAN NOT NULL DEFAULT false,
  `addedToCart`     BOOLEAN NOT NULL DEFAULT false,
  `reachedCheckout` BOOLEAN NOT NULL DEFAULT false,
  `orderId`         VARCHAR(191) NULL,

  INDEX `StorefrontSession_day_channel_idx` (`day`, `channel`),
  INDEX `StorefrontSession_visitorId_idx` (`visitorId`),
  INDEX `StorefrontSession_startedAt_idx` (`startedAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `AnalyticsDaily` (
  `day`               DATE NOT NULL,
  `channel`           VARCHAR(20) NOT NULL,
  `device`            VARCHAR(10) NOT NULL,
  `sessions`          INTEGER NOT NULL DEFAULT 0,
  `returningSessions` INTEGER NOT NULL DEFAULT 0,
  `productSessions`   INTEGER NOT NULL DEFAULT 0,
  `cartSessions`      INTEGER NOT NULL DEFAULT 0,
  `checkoutSessions`  INTEGER NOT NULL DEFAULT 0,
  `convertedSessions` INTEGER NOT NULL DEFAULT 0,
  `updatedAt`         DATETIME(3) NOT NULL,

  PRIMARY KEY (`day`, `channel`, `device`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `AdSpendDaily` (
  `day`               DATE NOT NULL,
  `platform`          VARCHAR(16) NOT NULL,
  `adId`              VARCHAR(40) NOT NULL,
  `adName`            VARCHAR(255) NULL,
  `adsetId`           VARCHAR(40) NOT NULL,
  `adsetName`         VARCHAR(255) NULL,
  `campaignId`        VARCHAR(40) NOT NULL,
  `campaignName`      VARCHAR(255) NULL,
  `spend`             DECIMAL(12, 2) NOT NULL DEFAULT 0,
  `impressions`       INTEGER NOT NULL DEFAULT 0,
  `reach`             INTEGER NOT NULL DEFAULT 0,
  `clicks`            INTEGER NOT NULL DEFAULT 0,
  `linkClicks`        INTEGER NOT NULL DEFAULT 0,
  `metaPurchases`     INTEGER NOT NULL DEFAULT 0,
  `metaPurchaseValue` DECIMAL(12, 2) NOT NULL DEFAULT 0,
  `metaAddToCarts`    INTEGER NOT NULL DEFAULT 0,
  `updatedAt`         DATETIME(3) NOT NULL,

  INDEX `AdSpendDaily_campaignId_day_idx` (`campaignId`, `day`),
  PRIMARY KEY (`day`, `platform`, `adId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
