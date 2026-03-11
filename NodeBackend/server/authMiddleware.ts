import type { Request, Response, NextFunction } from 'express';
import { authService, type AuthPayload } from './services/AuthService';

// Extend Express Request to include auth context
declare global {
  namespace Express {
    interface Request {
      auth?: AuthPayload;
    }
  }
}

/**
 * JWT authentication middleware.
 * Extracts and verifies token from Authorization header.
 * Sets req.auth with { userId, username, organizationId, role }.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ message: 'Authentication required' });
    return;
  }

  const token = authHeader.slice(7);
  try {
    const payload = authService.verifyToken(token);
    req.auth = payload;
    next();
  } catch {
    res.status(401).json({ message: 'Invalid or expired token' });
  }
}

/**
 * Super admin middleware — requires authenticated user with role 'super_admin'.
 */
export function requireSuperAdmin(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ message: 'Authentication required' });
    return;
  }

  const token = authHeader.slice(7);
  try {
    const payload = authService.verifyToken(token);
    if (payload.role !== 'super_admin') {
      res.status(403).json({ message: 'Super admin access required' });
      return;
    }
    req.auth = payload;
    next();
  } catch {
    res.status(401).json({ message: 'Invalid or expired token' });
  }
}

/**
 * Optional auth — sets req.auth if token present, but doesn't reject.
 * Useful for endpoints that work for both authenticated and anonymous users.
 */
export function optionalAuth(req: Request, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    try {
      req.auth = authService.verifyToken(authHeader.slice(7));
    } catch {
      // Ignore invalid token — treat as anonymous
    }
  }
  next();
}

/**
 * Extract tenant context from authenticated request.
 * Returns organizationId and userId from JWT payload.
 */
export function getTenant(req: Request): { organizationId: string; userId: string } {
  if (req.auth) {
    return {
      organizationId: req.auth.organizationId,
      userId: req.auth.userId,
    };
  }
  // Fallback for backwards compatibility during migration
  return {
    organizationId: (req.headers['x-organization-id'] as string) || 'default_org',
    userId: (req.headers['x-user-id'] as string) || 'default_user',
  };
}
