import "dotenv/config";
import express, { type Application } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import session from "express-session";
import connectDB, { getConnectionStatus } from "./config/database";
import errorHandler from "./middleware/errorHandler";
import notFoundHandler from "./middleware/notFoundHandler";
import { configurePassport } from "./config/passport";
import passport from "./config/passport";
import { createSuccessResponse } from "./utils";
import { HTTP_STATUS } from "./constant";

// Import routes
import productRoutes from "./routes/productRoutes";
import orderRoutes from "./routes/orderRoutes";
import adminAuthRoutes from "./routes/adminAuth";
import cartRoutes from "./routes/cartRoutes";
import uploadRoutes from "./routes/uploadRoutes";
import paymentRoutes from "./routes/paymentRoutes";
import recommendationRoutes from "./routes/recommendationRoutes";

const app: Application = express();

// Trust proxy
app.set("trust proxy", 1);

// CORS - Support multiple origins (comma-separated) or single origin
let allowedOrigins = process.env.CLIENT_URL
  ? process.env.CLIENT_URL.split(",")
      .map((url) => url.trim())
      .filter((url) => url.length > 0)
  : ["http://localhost:5173"];

// Normalize origins: remove trailing slashes and fix protocols
allowedOrigins = allowedOrigins.map((origin) => {
  // Remove trailing slash
  let normalized = origin.replace(/\/+$/, "");

  // If it's a Vercel domain using http://, always convert to https://
  if (normalized.startsWith("http://") && normalized.includes("vercel.app")) {
    normalized = normalized.replace("http://", "https://");
    console.warn(`[CORS] Auto-fixing Vercel domain: ${origin} → ${normalized}`);
  }
  // For other production domains, fix if in production mode
  else if (
    process.env.NODE_ENV === "production" &&
    normalized.startsWith("http://") &&
    (normalized.includes(".app") || normalized.includes(".com"))
  ) {
    normalized = normalized.replace("http://", "https://");
    console.warn(
      `[CORS] WARNING: ${origin} should use https:// in production. Using ${normalized} instead.`,
    );
  }

  return normalized;
});

// Log CORS configuration on startup
console.log("[CORS] Original CLIENT_URL:", process.env.CLIENT_URL || "not set");
console.log("[CORS] Configured allowed origins:", allowedOrigins);
if (
  process.env.CLIENT_URL &&
  process.env.CLIENT_URL.startsWith("http://") &&
  process.env.CLIENT_URL.includes("vercel.app")
) {
  console.warn(
    `[CORS] ⚠️  CLIENT_URL uses http:// but Vercel requires https://. Auto-fixed, but please update your Vercel environment variable!`,
  );
}
if (process.env.CLIENT_URL && process.env.CLIENT_URL.length < 10) {
  console.error(
    `[CORS] WARNING: CLIENT_URL seems too short (${process.env.CLIENT_URL.length} chars): "${process.env.CLIENT_URL}"`,
  );
}

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (like OAuth redirects, mobile apps, curl requests)
      if (!origin) {
        console.log("[CORS] Allowing request with no origin");
        return callback(null, true);
      }

      // In development, allow all origins
      if (process.env.NODE_ENV !== "production") {
        console.log(`[CORS] Development mode - allowing origin: ${origin}`);
        return callback(null, true);
      }

      // Normalize incoming origin: remove trailing slash
      const normalizedOrigin = origin.replace(/\/+$/, "");

      // Check if origin is in allowed list (exact match or normalized match)
      if (
        allowedOrigins.indexOf(normalizedOrigin) !== -1 ||
        allowedOrigins.indexOf(origin) !== -1
      ) {
        console.log(
          `[CORS] Allowing origin: ${origin} (normalized: ${normalizedOrigin})`,
        );
        callback(null, true);
      } else {
        // Be very permissive - allow Google domains, vercel domains, localhost
        if (
          normalizedOrigin.includes("accounts.google.com") ||
          normalizedOrigin.includes("googleusercontent.com") ||
          normalizedOrigin.includes("vercel.app") ||
          normalizedOrigin.includes("localhost") ||
          normalizedOrigin.includes("127.0.0.1")
        ) {
          console.log(`[CORS] Allowing permissive origin: ${normalizedOrigin}`);
          return callback(null, true);
        }
        // Even if not in list, allow it (very permissive)
        console.warn(
          `[CORS] Origin not in allowed list but allowing anyway: ${origin}. Allowed origins: ${allowedOrigins.join(", ")}`,
        );
        callback(null, true);
      }
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Requested-With",
      "Accept",
      "Origin",
    ],
    exposedHeaders: ["Content-Length", "Content-Type"],
    maxAge: 86400, // 24 hours
  }),
);

// Body parsing - less strict, allow larger payloads
app.use(express.json({ limit: "10mb", strict: false }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(cookieParser());

// Session - cookie settings for cross-origin
const isProduction = process.env.NODE_ENV === "production";
app.use(
  session({
    secret: process.env.SESSION_SECRET || "dev-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      // Force secure for HTTPS (required for sameSite: 'none')
      secure: true, // Always true for Vercel (HTTPS)
      httpOnly: true,
      // Force 'none' for cross-origin cookies
      sameSite: "none",
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    },
  }),
);

// Passport
configurePassport();
app.use(passport.initialize());
app.use(passport.session());

// API routes
app.use("/api/products", productRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/auth", adminAuthRoutes);
app.use("/api/cart", cartRoutes);
app.use("/api/upload", uploadRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/recommendations", recommendationRoutes);

// Health check
app.get("/health", (req, res) => {
  const payload = {
    message: "API is running",
    timestamp: new Date().toISOString(),
    database: getConnectionStatus() ? "connected" : "disconnected",
  };
  const { response, statusCode } = createSuccessResponse(
    payload,
    "OK",
    HTTP_STATUS.OK,
  );
  res.status(statusCode).json(response);
});

// 404 handler
app.use(notFoundHandler);

// Error handler
app.use(errorHandler);

// Bootstrap
async function bootstrap() {
  try {
    await connectDB();
  } catch (err) {
    console.error("Failed to connect to MongoDB. Exiting.");
    process.exit(1);
  }

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📡 API Base URL: http://localhost:${PORT}/api`);
    console.log(`🏥 Health check: http://localhost:${PORT}/health`);
  });
}

bootstrap();

export default app;
