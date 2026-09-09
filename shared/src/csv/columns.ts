/**
 * The fixed Shopify product-export columns, taken from the real export in
 * backend/shared/fixtures/products_export.csv.
 *
 * Metafield columns are deliberately NOT listed here. They are per-store and
 * dynamic — `Stud Type (product.metafields.custom.stud_type)` — so they are
 * recognised by pattern at import time and rebuilt from the definitions at
 * export time. Listing them here would make the importer treat them as known
 * fixed columns and silently skip every custom value in the file.
 *
 * Export writes these in this order so a round trip diffs cleanly against its
 * own source. Import maps by name and tolerates a different order or extra
 * columns, because a slightly different Shopify export must still load.
 */
export const SHOPIFY_CSV_COLUMNS = [
  "Handle",
  "Title",
  "Body (HTML)",
  "Vendor",
  "Product Category",
  "Type",
  "Tags",
  "Published",
  "Option1 Name",
  "Option1 Value",
  "Option1 Linked To",
  "Option2 Name",
  "Option2 Value",
  "Option2 Linked To",
  "Option3 Name",
  "Option3 Value",
  "Option3 Linked To",
  "Variant SKU",
  "Variant Grams",
  "Variant Inventory Tracker",
  "Variant Inventory Qty",
  "Variant Inventory Policy",
  "Variant Fulfillment Service",
  "Variant Price",
  "Variant Compare At Price",
  "Variant Requires Shipping",
  "Variant Taxable",
  "Unit Price Total Measure",
  "Unit Price Total Measure Unit",
  "Unit Price Base Measure",
  "Unit Price Base Measure Unit",
  "Variant Barcode",
  "Image Src",
  "Image Position",
  "Image Alt Text",
  "Gift Card",
  "SEO Title",
  "SEO Description",
  "Variant Image",
  "Variant Weight Unit",
  "Variant Tax Code",
  "Cost per item",
  "Status",
] as const;

export type ShopifyCsvColumn = (typeof SHOPIFY_CSV_COLUMNS)[number];

/** Columns in the reference export that are metafields rather than fixed fields. */
export const FIXTURE_METAFIELD_COLUMN_COUNT = 36;
