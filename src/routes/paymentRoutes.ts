import { Router } from "express";
import paymentController from "../controllers/paymentController";
import { requireAuth } from "../middleware/auth";

const router: Router = Router();

// PayPal returns here after the customer approves payment. The server captures and verifies it.
router.get("/paypal/callback", paymentController.paypalCallback);

// PayPal returns here when the customer cancels checkout.
router.get("/paypal/cancel", paymentController.paypalCancel);

// Optional authenticated endpoint for explicit server-side verification.
router.post(
  "/paypal/verify",
  requireAuth,
  paymentController.verifyPayPalPayment,
);

export default router;
