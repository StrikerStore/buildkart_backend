export { appRouter, type AppRouter } from './routers/index.ts';
export {
  createContext,
  clientIpFrom,
  refuseAllSessions,
  type AdminSessionVerifier,
  type ApiContext,
  type ContextOptions,
  type VerifiedAdmin,
} from './context.ts';
export { adminProcedure, publicProcedure, router } from './trpc.ts';
export { SESSION_TTL_SECONDS } from './auth/session.ts';
export { verifyAdminSession } from './auth/verifier.ts';

/**
 * DTO types, re-exported from `@buildkart/shared`.
 *
 * They live there rather than in `core` precisely so this re-export names a
 * package a client can safely depend on. Passing them through here means a
 * consumer imports one thing — the contract — rather than knowing which of the
 * backend's internals a given shape happens to come from.
 */
export type {
  BannerDto,
  CategoryDto,
  CustomerLookupResult,
  HomepageSectionDto,
  ImportOptions,
  MediaDto,
  MembershipPreviewDto,
  MembershipRowDto,
  MetafieldDefinitionDto,
  OrderEventDto,
  OrderListItemDto,
  PaymentTransactionDto,
  PincodeQuote,
  ProductListItemDto,
  UploadFailureReason,
  VariantSearchResult,
} from '@buildkart/shared';
