/**
 * @webwaka/core — Optimistic Locking Utility
 * Uses D1 version column for conflict detection.
 * Prevents lost updates in concurrent write scenarios (POS sync, inventory).
 */

export interface OptimisticLockResult {
  success: boolean;
  conflict: boolean;
  error?: string;
}

/**
 * Atomically update a row only if its version matches expectedVersion.
 * Increments version and sets updated_at on success.
 *
 * @param db               - D1Database binding
 * @param table            - Table name (must have id, tenant_id, version, deleted_at columns)
 * @param updates          - Key/value pairs to SET (excluding version and updated_at)
 * @param where            - Row selector: id, tenantId, expectedVersion
 * @returns OptimisticLockResult
 */
export async function updateWithVersionLock(
  db: D1Database,
  table: string,
  updates: Record<string, unknown>,
  where: { id: string; tenantId: string; expectedVersion: number },
): Promise<OptimisticLockResult> {
  try {
    const now = Date.now();
    const setClauses: string[] = [];
    const values: unknown[] = [];

    for (const [col, val] of Object.entries(updates)) {
      setClauses.push(`${col} = ?`);
      values.push(val);
    }

    setClauses.push('version = version + 1');
    setClauses.push('updated_at = ?');
    values.push(now);

    values.push(where.id, where.tenantId, where.expectedVersion);

    const sql = `UPDATE ${table} SET ${setClauses.join(', ')} WHERE id = ? AND tenant_id = ? AND version = ? AND deleted_at IS NULL`;

    const result = await db.prepare(sql).bind(...values).run();

    if ((result.meta?.changes ?? 0) === 0) {
      return { success: false, conflict: true };
    }

    return { success: true, conflict: false };
  } catch (err) {
    return {
      success: false,
      conflict: false,
      error: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}
