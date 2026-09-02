import { Request, Response, NextFunction } from "express";
import { verifyJwt, JwtUser } from "../config/passport";
import { HTTP_STATUS, API_MESSAGES } from "../constant";

export interface AuthRequest extends Request {
  user?: JwtUser;
}

function getToken(req: Request): string | null {
  const cookieToken = req.cookies?.auth_token;
  if (cookieToken) return cookieToken;

  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice(7).trim();

  return null;
}

export const requireAuth = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  const token = getToken(req);
  if (!token) {
    res.status(HTTP_STATUS.UNAUTHORIZED).json({
      success: false,
      message: API_MESSAGES.UNAUTHORIZED,
    });
    return;
  }

  const user = verifyJwt(token);
  if (!user?.email) {
    res.status(HTTP_STATUS.UNAUTHORIZED).json({
      success: false,
      message: API_MESSAGES.UNAUTHORIZED,
    });
    return;
  }

  (req as AuthRequest).user = user;
  next();
};

export function getAuthenticatedUser(req: Request): JwtUser | null {
  const token = getToken(req);
  return token ? verifyJwt(token) : null;
}
