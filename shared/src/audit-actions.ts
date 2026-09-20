/**
 * Human words for the audit trail.
 *
 * `AdminAuditLog.action` is a machine string — `category.create`,
 * `order.payment.delete` — chosen where the write happens because it has to be
 * greppable and stable. Nobody reading the change log wants to see it. This is
 * the one place those strings become sentences, and it lives in `shared` so the
 * screen rendering them and the writes emitting them are checked against the
 * same list.
 *
 * Keeping the map exhaustive is a deliberate maintenance cost: add an action in
 * `core/src/write/` and add it here, or `describeAction` degrades to the raw
 * string. It degrades rather than throws — a missing label must never be able to
 * take down the screen that would tell you what happened.
 */

/**
 * Every action string emitted by `recordAudit`, mapped to what a person would
 * say happened. Grouped the way the writes are grouped, not alphabetically.
 */
export const AUDIT_ACTION_LABELS: Record<string, string> = {
  // Admin account and session
  'admin.login': 'Signed in',
  'admin.password': 'Changed their password',
  'admin.password.failed': 'Failed a password change',
  'admin.profile': 'Updated their profile',

  // Catalog
  'product.create': 'Created a product',
  'product.update': 'Updated a product',
  'product.delete': 'Deleted a product',
  'product.duplicate': 'Duplicated a product',
  'product.bulkStatus': 'Changed the status of several products',
  'product.bulkTag': 'Tagged several products',
  'product.active': 'Published a product',
  'product.draft': 'Moved a product back to draft',
  'product.archived': 'Archived a product',

  'category.create': 'Created a category',
  'category.update': 'Updated a category',
  'category.delete': 'Deleted a category',
  'category.reorder': 'Reordered the categories',
  'category.activate': 'Turned a category on',
  'category.deactivate': 'Turned a category off',

  'tag.create': 'Created a tag',
  'tag.update': 'Updated a tag',
  'tag.delete': 'Deleted a tag',
  'tag.merge': 'Merged two tags',

  'metafield.definition.create': 'Created a custom field',
  'metafield.definition.update': 'Updated a custom field',
  'metafield.definition.delete': 'Deleted a custom field',

  'rates.save': "Updated today's rates",
  'bulkTiers.save': 'Updated bulk price ladders',

  'tax.rate.create': 'Created a tax rate',
  'tax.rate.update': 'Updated a tax rate',
  'tax.rate.delete': 'Deleted a tax rate',
  'tax.rate.reorder': 'Reordered the tax rates',

  'inventory.adjust': 'Adjusted stock',

  // Media
  'media.update': 'Updated an image',
  'media.delete': 'Deleted an image',
  'media.bulkDelete': 'Deleted several images',

  // Import
  'import.dryRun': 'Analysed a CSV import',
  'import.commit': 'Committed a CSV import',
  'import.cancel': 'Cancelled a CSV import',

  // Orders
  'order.create': 'Created an order',
  'order.status': 'Changed an order status',
  'order.cancel': 'Cancelled an order',
  'order.note': 'Edited an order note',
  'order.payment': 'Recorded a payment',
  'order.refund': 'Recorded a refund',
  'order.payment.delete': 'Removed a payment record',

  // Customers
  'customer.update': 'Updated a customer',
  'customer.block': 'Blocked a customer',
  'customer.unblock': 'Unblocked a customer',

  // Support
  'support.reply': 'Replied to a support conversation',
  'support.resolve': 'Marked a support conversation resolved',
  'support.reopen': 'Reopened a support conversation',
  'support.cannedReply.save': 'Saved a saved reply',
  'support.cannedReply.delete': 'Deleted a saved reply',

  // Growth
  'discount.create': 'Created a discount',
  'discount.update': 'Updated a discount',
  'discount.delete': 'Deleted a discount',
  'discount.enable': 'Turned a discount on',
  'discount.disable': 'Turned a discount off',

  'delivery.pincode.create': 'Added a delivery area',
  'delivery.pincode.update': 'Updated a delivery area',
  'delivery.pincode.delete': 'Removed a delivery area',
  'delivery.requests.notified': 'Marked area requests as notified',

  'delivery.warehouse.create': 'Added a warehouse',
  'delivery.warehouse.update': 'Updated a warehouse',
  'delivery.warehouse.delete': 'Removed a warehouse',
  'delivery.warehouse.stock': 'Updated what a warehouse stocks',
  'delivery.distancePricing': 'Updated the distance delivery charges',

  // Content
  'banner.create': 'Created a banner',
  'banner.update': 'Updated a banner',
  'banner.delete': 'Deleted a banner',
  'banner.reorder': 'Reordered the banners',
  'banner.enable': 'Turned a banner on',
  'banner.disable': 'Turned a banner off',

  'review.create': 'Posted a customer review',
  'review.update': 'Updated a customer review',
  'review.delete': 'Deleted a customer review',
  'review.reorder': 'Reordered the customer reviews',
  'review.enable': 'Showed a customer review',
  'review.disable': 'Hid a customer review',

  'homepage.create': 'Added a homepage section',
  'homepage.update': 'Updated a homepage section',
  'homepage.delete': 'Removed a homepage section',
  'homepage.reorder': 'Reordered the homepage',
  'homepage.enable': 'Turned a homepage section on',
  'homepage.disable': 'Turned a homepage section off',

  'page.create': 'Created a page',
  'page.update': 'Updated a page',
  'page.delete': 'Deleted a page',
  'page.publish': 'Published a page',
  'page.unpublish': 'Unpublished a page',
  'page.reorder': 'Reordered the pages',

  'blog.create': 'Wrote a blog post',
  'blog.update': 'Edited a blog post',
  'blog.delete': 'Deleted a blog post',
  'blog.publish': 'Published a blog post',
  'blog.unpublish': 'Unpublished a blog post',

  'menu.save': 'Rebuilt a menu',

  'checkout.flow': 'Changed the checkout flow',
  'checkout.fields': 'Changed the checkout fields',
  'checkout.content': 'Reworded the checkout',
  'checkout.design': 'Restyled the checkout',
  'checkout.location': 'Changed the location picker',

  'notification.template': 'Edited a customer message',
  'notification.template.delete': 'Deleted a customer message',
  'notification.provider': 'Changed a messaging provider',

  'seo.update': 'Updated the search engine defaults',
  'announcements.update': 'Changed the announcement bar',

  // Settings
  'payments.configure': 'Changed a payment provider',
  'payments.reorder': 'Reordered the payment methods',

  'settings.store': 'Updated the store details',
  'settings.commerce': 'Updated the order and payment settings',
};

/** The label, or the raw action when nothing has been written for it yet. */
export function describeAction(action: string): string {
  return AUDIT_ACTION_LABELS[action] ?? action;
}

/**
 * The coarse group an action belongs to, taken from the part before the first
 * dot. Drives the filter dropdown, so it needs no second list to fall out of
 * date with.
 */
export function actionGroup(action: string): string {
  const [group] = action.split('.');
  return group ?? action;
}

/** Every group present in the labels above, sorted for a stable dropdown. */
export const AUDIT_ACTION_GROUPS: string[] = [
  ...new Set(Object.keys(AUDIT_ACTION_LABELS).map(actionGroup)),
].sort();

/** `AdminAuditLog.entityType` values, as a person would name them. */
export const AUDIT_ENTITY_LABELS: Record<string, string> = {
  AdminUser: 'Admin',
  Banner: 'Banner',
  Category: 'Category',
  Customer: 'Customer',
  CustomerReview: 'Customer review',
  Discount: 'Discount',
  HomepageSection: 'Homepage section',
  ImportJob: 'CSV import',
  Media: 'Image',
  MetafieldDefinition: 'Custom field',
  Order: 'Order',
  PincodeRequest: 'Area request',
  Product: 'Product',
  ProductVariant: 'Variant',
  ServiceablePincode: 'Delivery area',
  BlogPost: 'Blog post',
  Menu: 'Menu',
  NotificationTemplate: 'Customer message',
  Page: 'Page',
  Setting: 'Setting',
  Tag: 'Tag',
  TaxRate: 'Tax rate',
};

export function describeEntity(entityType: string): string {
  return AUDIT_ENTITY_LABELS[entityType] ?? entityType;
}

/** The entity types the filter offers, sorted by their labels. */
export const AUDIT_ENTITY_TYPES: string[] = Object.keys(AUDIT_ENTITY_LABELS).sort((a, b) =>
  AUDIT_ENTITY_LABELS[a]!.localeCompare(AUDIT_ENTITY_LABELS[b]!),
);

/**
 * Where to send someone who wants to see the thing that changed.
 *
 * Null for entities with no screen of their own — a `Setting` has no detail
 * page, a deleted product's id no longer resolves — and the row then renders as
 * plain text rather than a link that 404s.
 *
 * Bulk actions carry the id of one representative row, which is why this maps
 * the *entity*, not the action: `product.bulkTag` and `product.update` both
 * point at a product, and only one of them changed a single thing.
 */
export function linkForEntity(entityType: string, entityId: string): string | null {
  switch (entityType) {
    case 'Product':
      return `/products/${entityId}`;
    case 'Category':
      return `/categories/${entityId}`;
    case 'Tag':
      return `/tags/${entityId}`;
    case 'MetafieldDefinition':
      return `/metafields/${entityId}`;
    case 'Customer':
      return `/customers/${entityId}`;
    case 'Order':
      return `/orders/${entityId}`;
    case 'ImportJob':
      return `/products/import/${entityId}`;
    case 'Setting':
      /*
       * `Setting` is one table behind several screens, so the row's own key is
       * what decides where "open it" should go. Without this, a checkout
       * change in the log would send you to the store details page.
       */
      if (entityId.startsWith('checkout.')) return '/checkout';
      if (entityId.startsWith('notifications.')) return '/notifications';
      if (entityId.startsWith('payments.')) return '/settings/payments';
      if (entityId === 'delivery.distancePricing') return '/delivery/charges';
      if (entityId === 'seo.defaults') return '/seo';
      return '/settings';
    case 'TaxRate':
      return '/settings/tax';
    case 'Discount':
      return '/discounts';
    case 'ServiceablePincode':
      return '/delivery/pincodes';
    case 'PincodeRequest':
      return '/delivery/requests';
    case 'Warehouse':
      return `/delivery/warehouses/${entityId}`;
    case 'Page':
      return `/pages/${entityId}`;
    case 'BlogPost':
      return `/blog/${entityId}`;
    case 'Menu':
      return '/menus';
    case 'NotificationTemplate':
      return '/notifications';
    case 'Banner':
      return '/banners';
    case 'CustomerReview':
      return '/reviews';
    case 'HomepageSection':
      return '/homepage';
    case 'Media':
      return '/media';
    default:
      return null;
  }
}
