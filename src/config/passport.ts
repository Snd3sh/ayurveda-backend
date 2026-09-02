import passport from "passport";
import { Strategy as GoogleStrategy, Profile } from "passport-google-oauth20";
import jwt, { type Secret, type SignOptions } from "jsonwebtoken";
import type { Request } from "express";

export interface JwtUser {
  id: string;
  name: string;
  email: string;
  picture?: string;
  role?: string;
}

export function signJwt(user: JwtUser): string {
  try {
    // Fallback to dev-secret if JWT_SECRET is not set (with warning in production)
    const secret: Secret = (process.env.JWT_SECRET || "dev-secret") as Secret;

    if (!process.env.JWT_SECRET) {
      if (process.env.NODE_ENV === "production") {
        console.error(
          "[JWT] WARNING: JWT_SECRET not set in production! Using fallback secret. This is insecure!",
        );
      } else {
        console.warn("[JWT] JWT_SECRET not set, using fallback dev-secret");
      }
    }

    const options: SignOptions = {};
    const expiresInEnv = process.env.JWT_EXPIRES_IN || "7d";
    (options as any).expiresIn = expiresInEnv;

    const token = jwt.sign(user as any, secret, options as any);
    console.log("[JWT] Token signed successfully for user:", user.email);
    return token;
  } catch (error: any) {
    console.error("[JWT] Error signing token:", error.message || error);
    // Fallback: try with a default secret if the original fails
    try {
      const fallbackSecret: Secret = "fallback-secret-key" as Secret;
      console.warn("[JWT] Attempting fallback token signing");
      return jwt.sign(user as any, fallbackSecret, { expiresIn: "7d" });
    } catch (fallbackError: any) {
      console.error(
        "[JWT] Fallback token signing also failed:",
        fallbackError.message || fallbackError,
      );
      throw new Error("Failed to sign JWT token");
    }
  }
}

export function verifyJwt(token: string): JwtUser | null {
  if (!token || typeof token !== "string" || token.trim().length === 0)
    return null;

  try {
    const secret: Secret = (process.env.JWT_SECRET || "dev-secret") as Secret;
    const verified = jwt.verify(token, secret) as JwtUser;

    if (!verified?.id || !verified?.email) return null;
    return verified;
  } catch (error: any) {
    console.warn("[JWT] Verification failed:", error?.name || "UnknownError");
    return null;
  }
}

export function configurePassport(): boolean {
  const clientID = process.env.GOOGLE_CLIENT_ID || "";
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET || "";
  const callbackURL =
    process.env.OAUTH_CALLBACK_URL || "/api/auth/google/callback";
  const adminEmails = (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);

  if (!clientID || !clientSecret) {
    console.warn(
      "[auth] Google OAuth not configured. Missing client id/secret.",
    );
    return false;
  }

  passport.use(
    new GoogleStrategy(
      {
        clientID,
        clientSecret,
        callbackURL,
        passReqToCallback: true,
      },
      async (
        _req: Request,
        _accessToken: string,
        _refreshToken: string,
        profile: Profile,
        done,
      ) => {
        try {
          const email = profile.emails?.[0]?.value || "";

          // Check if email is in admin list
          const isAdmin = adminEmails.length > 0 && adminEmails.includes(email);

          const user: JwtUser = {
            id: profile.id,
            name: profile.displayName,
            email,
            picture: profile.photos?.[0]?.value,
            role: isAdmin ? "admin" : undefined,
          };

          return done(null, user);
        } catch (err) {
          return done(err as Error);
        }
      },
    ),
  );

  passport.serializeUser((user: any, done) => {
    done(null, user);
  });

  passport.deserializeUser((user: any, done) => {
    done(null, user);
  });

  console.info(
    "[auth] Google OAuth strategy configured with callback:",
    callbackURL,
  );
  return true;
}

export default passport;
