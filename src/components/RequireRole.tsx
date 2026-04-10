import { ReactNode } from 'react';

interface RequireRoleProps {
  role: string | string[];
  userRole: string;
  children: ReactNode;
  fallback?: ReactNode;
}

export function RequireRole({ role, userRole, children, fallback = null }: RequireRoleProps) {
  const allowed = Array.isArray(role) ? role.includes(userRole) : role === userRole;
  return <>{allowed ? children : fallback}</>;
}
