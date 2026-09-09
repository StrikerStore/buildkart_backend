import { prisma } from './client.ts';

export type DatabaseHealth = {
  db: 'ok' | 'error';
  charset?: string;
  collation?: string;
  version?: string;
  latencyMs?: number;
  error?: string;
  /** Populated when the database is reachable but misconfigured in a way that will corrupt data. */
  warnings?: string[];
};

type VariableRow = { Variable_name: string; Value: string };

/**
 * Confirms the database is reachable *and* configured correctly.
 *
 * The charset assertion is not ceremony. A database that defaults to latin1
 * accepts a write of "₹410" or a Devanagari product name and silently stores
 * mojibake; the failure surfaces weeks later as unreadable text in the catalog,
 * long after the import that caused it. Checking it on every health probe makes
 * a misconfigured Railway instance visible on day one.
 */
export async function checkDatabaseHealth(): Promise<DatabaseHealth> {
  const startedAt = Date.now();

  try {
    const [charsetRows, collationRows, versionRows] = await Promise.all([
      prisma.$queryRaw<VariableRow[]>`SHOW VARIABLES LIKE 'character_set_database'`,
      prisma.$queryRaw<VariableRow[]>`SHOW VARIABLES LIKE 'collation_database'`,
      prisma.$queryRaw<Array<{ version: string }>>`SELECT VERSION() AS version`,
    ]);

    const charset = charsetRows[0]?.Value;
    const collation = collationRows[0]?.Value;
    const version = versionRows[0]?.version;

    const warnings: string[] = [];
    if (charset !== 'utf8mb4') {
      warnings.push(
        `character_set_database is "${charset}", expected "utf8mb4". Rupee signs and Devanagari will be corrupted on write.`,
      );
    }

    return {
      db: 'ok',
      charset,
      collation,
      version,
      latencyMs: Date.now() - startedAt,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  } catch (error) {
    return {
      db: 'error',
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
