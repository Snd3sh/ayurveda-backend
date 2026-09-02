import { Request, Response, NextFunction } from "express";
import { verifyJwt, JwtUser } from "../config/passport";
import { HTTP_STATUS, API_MESSAGES } from "../constant";

export interface AuthRequest extends Request {
  user?: JwtUser;
}

export const adminAuth = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  const authReq = req as AuthRequest;

  // Set CORS headers first (less strict)
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET, POST, PUT, DELETE, OPTIONS, PATCH",
    );
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, X-Requested-With, Accept, Origin",
    );
  }

  try {
    const token =
      req.cookies?.auth_token ||
      (req.headers.authorization?.startsWith("Bearer ")
        ? req.headers.authorization.slice(7).trim()
        : null);

    if (!token) {
      res.status(HTTP_STATUS.UNAUTHORIZED).json({
        success: false,
        message: API_MESSAGES.UNAUTHORIZED,
      });
      return;
    }

    const user = verifyJwt(token);

    if (!user) {
      console.warn("[adminAuth] Token verification failed");
      res.status(HTTP_STATUS.UNAUTHORIZED).json({
        success: false,
        message: API_MESSAGES.UNAUTHORIZED,
      });
      return;
    }

    // Admin access must always be explicitly configured.
    const adminEmails = (process.env.ADMIN_EMAILS || "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
    if (!adminEmails.includes(user.email.toLowerCase())) {
      console.warn("[adminAuth] User is not admin:", user.email);
      res.status(HTTP_STATUS.FORBIDDEN).json({
        success: false,
        message: API_MESSAGES.ADMIN_REQUIRED,
      });
      return;
    }

    authReq.user = user;
    next();
  } catch (error: any) {
    console.error("[adminAuth] Error:", error.message || error);
    // Set CORS headers even on error
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
    res.status(HTTP_STATUS.UNAUTHORIZED).json({
      success: false,
      message: API_MESSAGES.UNAUTHORIZED,
    });
  }
};
