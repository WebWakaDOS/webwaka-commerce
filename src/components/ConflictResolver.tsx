import React, { useState, useEffect, useCallback } from 'react';
import { getCommerceDB } from '../core/offline/db';
import type { SyncConflict } from '../core/offline/db';

interface ConflictResolverProps {
  tenantId: string;
}

export function ConflictResolver({ tenantId }: ConflictResolverProps) {
  const [conflicts, setConflicts] = useState<SyncConflict[]>([]);
  const [open, setOpen] = useState(false);

  const loadConflicts = useCallback(async () => {
    try {
      const db = getCommerceDB(tenantId);
      const unresolved = await db.syncConflicts
        .where('tenantId')
        .equals(tenantId)
        .filter(c => !c.resolvedAt)
        .toArray();
      setConflicts(unresolved);
    } catch {
      // IndexedDB may not be available in all environments
    }
  }, [tenantId]);

  useEffect(() => {
    loadConflicts();
    const interval = setInterval(loadConflicts, 30_000);
    return () => clearInterval(interval);
  }, [loadConflicts]);

  const handleAccept = useCallback(async (conflict: SyncConflict) => {
    try {
      const db = getCommerceDB(tenantId);
      await db.syncConflicts.update(conflict.id, { resolvedAt: Date.now() });
      await loadConflicts();
    } catch {
      // silent
    }
  }, [tenantId, loadConflicts]);

  const handleRetry = useCallback(async (conflict: SyncConflict) => {
    try {
      const db = getCommerceDB(tenantId);
      await db.mutations.add({
        tenantId,
        entityType: conflict.entityType as 'order' | 'product' | 'cart' | 'vendor',
        entityId: conflict.entityId,
        action: 'UPDATE',
        payload: conflict.localPayload,
        version: Date.now(),
        timestamp: Date.now(),
        status: 'PENDING',
        retryCount: 0,
      });
      await db.syncConflicts.update(conflict.id, { resolvedAt: Date.now() });
      await loadConflicts();
    } catch {
      // silent
    }
  }, [tenantId, loadConflicts]);

  if (conflicts.length === 0) return null;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-label={`${conflicts.length} sync conflict${conflicts.length !== 1 ? 's' : ''}`}
        style={{
          position: 'relative', background: '#b91c1c', color: '#fff',
          border: 'none', borderRadius: '6px', padding: '4px 10px',
          fontSize: '12px', fontWeight: 700, cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: '4px',
        }}
      >
        <span
          style={{
            background: '#fef2f2', color: '#b91c1c', borderRadius: '50%',
            width: '18px', height: '18px', fontSize: '11px', fontWeight: 900,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          {conflicts.length}
        </span>
        Conflicts
      </button>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Sync Conflicts"
          style={{
            position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 9999, padding: '16px',
          }}
          onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}
        >
          <div style={{
            background: '#fff', borderRadius: '12px', padding: '20px',
            maxWidth: '480px', width: '100%', maxHeight: '80vh', overflowY: 'auto',
            boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <h2 style={{ margin: 0, fontSize: '16px', fontWeight: 700, color: '#111827' }}>
                Sync Conflicts ({conflicts.length})
              </h2>
              <button
                onClick={() => setOpen(false)}
                style={{ border: 'none', background: 'none', fontSize: '20px', cursor: 'pointer', color: '#6b7280' }}
                aria-label="Close conflict resolver"
              >
                ×
              </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {conflicts.map((conflict) => (
                <div
                  key={conflict.id}
                  style={{
                    border: '1px solid #fecaca', borderRadius: '8px',
                    padding: '12px', backgroundColor: '#fef2f2',
                  }}
                >
                  <div style={{ fontSize: '13px', fontWeight: 600, color: '#111827', marginBottom: '4px' }}>
                    {conflict.entityType} — {conflict.conflictType}
                  </div>
                  <div style={{ fontSize: '11px', color: '#6b7280', marginBottom: '8px' }}>
                    {new Date(conflict.occurredAt).toLocaleString('en-NG')}
                  </div>
                  <div style={{ fontSize: '12px', color: '#7f1d1d', marginBottom: '10px', fontStyle: 'italic' }}>
                    This action was rejected by the server
                    {conflict.serverMessage ? `: ${conflict.serverMessage}` : '.'}
                  </div>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button
                      onClick={() => handleAccept(conflict)}
                      style={{
                        flex: 1, padding: '6px 12px', borderRadius: '6px',
                        border: '1px solid #d1d5db', background: '#fff', color: '#374151',
                        fontSize: '12px', fontWeight: 600, cursor: 'pointer',
                      }}
                    >
                      Accept Server State
                    </button>
                    <button
                      onClick={() => handleRetry(conflict)}
                      style={{
                        flex: 1, padding: '6px 12px', borderRadius: '6px',
                        border: 'none', background: '#16a34a', color: '#fff',
                        fontSize: '12px', fontWeight: 600, cursor: 'pointer',
                      }}
                    >
                      Retry
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
