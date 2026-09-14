-- Customer reviews.
--
-- Written into the admin by the owner — there is no storefront form — and shown
-- only in the home page's CUSTOMER_REVIEWS band. Two tables: the review, and
-- its photos and videos as a join to `Media`, so the files sit in the library
-- under the same in-use guard and GC rules as every other upload.
--
-- `customerPhone` is private. The storefront is told only whether it is set,
-- which is what the "Verified customer" badge means.

-- Re-runnable, like `price_tiers`. MySQL has no transactional DDL, so a failure
-- partway leaves the earlier statements applied and a retry dies on "table
-- already exists". Nothing can have written to these tables before this
-- migration completes, so dropping a half-built pair is safe. Child first: the
-- join's foreign key would otherwise block dropping the review table.
DROP TABLE IF EXISTS `CustomerReviewMedia`;
DROP TABLE IF EXISTS `CustomerReview`;

-- CreateTable
CREATE TABLE `CustomerReview` (
    `id` VARCHAR(191) NOT NULL,
    `customerName` VARCHAR(191) NOT NULL,
    `customerPhone` VARCHAR(20) NULL,
    `rating` INTEGER NOT NULL,
    `body` TEXT NOT NULL,
    `position` INTEGER NOT NULL DEFAULT 0,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    -- The schema refuses anything else too; this is for a write that skips it.
    CONSTRAINT `CustomerReview_rating_range` CHECK (`rating` BETWEEN 1 AND 5),

    INDEX `CustomerReview_isActive_position_idx`(`isActive`, `position`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CustomerReviewMedia` (
    `id` VARCHAR(191) NOT NULL,
    `reviewId` VARCHAR(191) NOT NULL,
    `mediaId` VARCHAR(191) NOT NULL,
    `position` INTEGER NOT NULL DEFAULT 0,

    INDEX `CustomerReviewMedia_reviewId_position_idx`(`reviewId`, `position`),
    INDEX `CustomerReviewMedia_mediaId_idx`(`mediaId`),
    UNIQUE INDEX `CustomerReviewMedia_reviewId_mediaId_key`(`reviewId`, `mediaId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `CustomerReviewMedia` ADD CONSTRAINT `CustomerReviewMedia_reviewId_fkey` FOREIGN KEY (`reviewId`) REFERENCES `CustomerReview`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- RESTRICT: a file on a review cannot be deleted from the library until the
-- review lets go of it, matching how product images are protected.
ALTER TABLE `CustomerReviewMedia` ADD CONSTRAINT `CustomerReviewMedia_mediaId_fkey` FOREIGN KEY (`mediaId`) REFERENCES `Media`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
