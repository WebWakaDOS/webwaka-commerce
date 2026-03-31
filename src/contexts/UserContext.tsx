import { createContext, useContext } from 'react';

export interface UserContextValue {
  userId: string;
  role: string;
  tenantId: string;
}

export const UserContext = createContext<UserContextValue>({
  userId: '',
  role: 'STAFF',
  tenantId: '',
});

export function useUserContext(): UserContextValue {
  return useContext(UserContext);
}

export const useUser = useUserContext;

export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const b64 = parts[1]!.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64.padEnd(b64.length + (4 - (b64.length % 4)) % 4, '=');
    return JSON.parse(atob(padded)) as Record<string, unknown>;
  } catch {
    return null;
  }
}
