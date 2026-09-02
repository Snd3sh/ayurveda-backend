import { Request, Response } from "express";
import Order from "../models/Order";
import Product from "../models/Product";
import { createSuccessResponse, createErrorResponse } from "../utils";
import { HTTP_STATUS } from "../constant";
import { AuthRequest } from "../middleware/auth";

const PAYPAL_BASE_URL =
  process.env.PAYPAL_BASE_URL || "https://api-m.sandbox.paypal.com";
const PAYPAL_NPR_TO_USD = Number(process.env.PAYPAL_NPR_TO_USD || 0.0075);

function roundUsd(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function isAdmin(user: AuthRequest["user"]): boolean {
  const adminEmails = (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
  return (
    user?.role === "admin" ||
    (!!user?.email && adminEmails.includes(user.email.toLowerCase()))
  );
}

async function getPayPalAccessToken(): Promise<string> {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("PayPal is not configured on the server.");
  }

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString(
    "base64",
  );
  const response: any = await fetch(`${PAYPAL_BASE_URL}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  const data: any = await response.json();
  if (!response.ok || !data.access_token) {
    throw new Error(
      data?.error_description || "Unable to authenticate with PayPal.",
    );
  }

  return data.access_token;
}

export async function createPayPalOrder(params: {
  orderId: string;
  totalNpr: number;
}): Promise<{ paypalOrderId: string; approvalUrl: string; amountUsd: string }> {
  if (!Number.isFinite(PAYPAL_NPR_TO_USD) || PAYPAL_NPR_TO_USD <= 0) {
    throw new Error("Invalid PAYPAL_NPR_TO_USD configuration.");
  }

  const accessToken = await getPayPalAccessToken();
  const amountUsd = roundUsd(params.totalNpr * PAYPAL_NPR_TO_USD);

  if (amountUsd < 0.01) {
    throw new Error("Order amount is too small for PayPal.");
  }

  const returnUrl =
    process.env.PAYPAL_RETURN_URL ||
    "http://localhost:3000/api/payments/paypal/callback";
  const cancelUrl =
    process.env.PAYPAL_CANCEL_URL ||
    "http://localhost:3000/api/payments/paypal/cancel";

  const response: any = await fetch(`${PAYPAL_BASE_URL}/v2/checkout/orders`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [
        {
          reference_id: params.orderId,
          custom_id: params.orderId,
          description: `AyurVeda order ${params.orderId}`,
          amount: {
            currency_code: "USD",
            value: amountUsd.toFixed(2),
          },
        },
      ],
      application_context: {
        brand_name: "AyurVeda",
        user_action: "PAY_NOW",
        return_url: returnUrl,
        cancel_url: cancelUrl,
      },
    }),
  });

  const data: any = await response.json();
  if (!response.ok || !data.id) {
    throw new Error(data?.message || "Unable to create PayPal order.");
  }

  const approvalLink = Array.isArray(data.links)
    ? data.links.find((link: any) => link.rel === "approve")?.href
    : undefined;

  if (!approvalLink) {
    throw new Error("PayPal approval URL was not returned.");
  }

  return {
    paypalOrderId: data.id,
    approvalUrl: approvalLink,
    amountUsd: amountUsd.toFixed(2),
  };
}

async function capturePayPalOrder(paypalOrderId: string): Promise<any> {
  const accessToken = await getPayPalAccessToken();

  const response: any = await fetch(
    `${PAYPAL_BASE_URL}/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}/capture`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
    },
  );

  const data: any = await response.json();
  if (!response.ok) {
    throw new Error(data?.message || "PayPal payment capture failed.");
  }

  return data;
}

function getCapturedAmount(data: any): number | null {
  const capture = data?.purchase_units?.[0]?.payments?.captures?.[0];
  const value = Number(capture?.amount?.value);
  return Number.isFinite(value) ? value : null;
}

async function restoreReservedStockOnce(order: any): Promise<void> {
  const claimed = await Order.findOneAndUpdate(
    { _id: order._id, stockRestored: false, isPaid: false },
    { $set: { stockRestored: true } },
    { new: true },
  );

  if (!claimed) return;

  for (const item of order.orderItems) {
    await Product.findByIdAndUpdate(item.product, {
      $inc: { stock: item.quantity },
    });
  }
}

class PaymentController {
  paypalCallback = async (req: Request, res: Response): Promise<void> => {
    const frontend = process.env.CLIENT_URL || "http://localhost:5173";
    const paypalOrderId = String(req.query.token || "");

    if (!paypalOrderId) {
      res.redirect(`${frontend}/payment/result?status=failed`);
      return;
    }

    try {
      const order = await Order.findOne({ paypalOrderId });
      if (!order) throw new Error("Order not found for this PayPal payment.");

      if (order.isPaid) {
        res.redirect(
          `${frontend}/payment/result?status=success&orderId=${encodeURIComponent(order._id.toString())}`,
        );
        return;
      }

      order.paymentStatus = "Pending";
      await order.save();

      const data = await capturePayPalOrder(paypalOrderId);
      const capturedAmount = getCapturedAmount(data);
      const expectedAmount = roundUsd(order.totalPrice * PAYPAL_NPR_TO_USD);
      const amountMatches =
        capturedAmount !== null && capturedAmount === expectedAmount;
      const captureStatus = data?.status;

      if (captureStatus === "COMPLETED" && amountMatches) {
        const transactionId =
          data?.purchase_units?.[0]?.payments?.captures?.[0]?.id;
        order.isPaid = true;
        order.paidAt = order.paidAt || new Date();
        order.paymentStatus = "Completed";
        order.paymentTransactionId = transactionId || undefined;
        order.status = order.status === "pending" ? "processing" : order.status;
        await order.save();

        res.redirect(
          `${frontend}/payment/result?status=success&orderId=${encodeURIComponent(order._id.toString())}`,
        );
        return;
      }

      await restoreReservedStockOnce(order);
      order.paymentStatus = "Failed";
      order.status = "cancelled";
      await order.save();
      res.redirect(
        `${frontend}/payment/result?status=failed&orderId=${encodeURIComponent(order._id.toString())}`,
      );
    } catch (error: any) {
      console.error("PayPal callback error:", error);
      res.redirect(`${frontend}/payment/result?status=failed`);
    }
  };

  paypalCancel = async (req: Request, res: Response): Promise<void> => {
    const frontend = process.env.CLIENT_URL || "http://localhost:5173";
    const paypalOrderId = String(req.query.token || "");

    try {
      if (paypalOrderId) {
        const order = await Order.findOne({ paypalOrderId });
        if (order && !order.isPaid) {
          await restoreReservedStockOnce(order);
          order.paymentStatus = "Cancelled";
          order.status = "cancelled";
          await order.save();
          res.redirect(
            `${frontend}/payment/result?status=cancelled&orderId=${encodeURIComponent(order._id.toString())}`,
          );
          return;
        }
      }
    } catch (error) {
      console.error("PayPal cancellation error:", error);
    }

    res.redirect(`${frontend}/payment/result?status=cancelled`);
  };

  verifyPayPalPayment = async (req: Request, res: Response): Promise<void> => {
    try {
      const { paypalOrderId } = req.body;
      if (!paypalOrderId) {
        const { response, statusCode } = createErrorResponse(
          "paypalOrderId is required",
          HTTP_STATUS.BAD_REQUEST,
        );
        res.status(statusCode).json(response);
        return;
      }

      const order = await Order.findOne({ paypalOrderId });
      if (!order) {
        const { response, statusCode } = createErrorResponse(
          "Order for this PayPal payment was not found",
          HTTP_STATUS.NOT_FOUND,
        );
        res.status(statusCode).json(response);
        return;
      }

      const user = (req as AuthRequest).user;
      if (!isAdmin(user) && order.user.email !== user?.email) {
        const { response, statusCode } = createErrorResponse(
          "You can only verify your own payment",
          HTTP_STATUS.FORBIDDEN,
        );
        res.status(statusCode).json(response);
        return;
      }

      if (order.isPaid) {
        const { response, statusCode } = createSuccessResponse(
          order,
          "Payment is already verified",
        );
        res.status(statusCode).json(response);
        return;
      }

      const data = await capturePayPalOrder(paypalOrderId);
      const capturedAmount = getCapturedAmount(data);
      const expectedAmount = roundUsd(order.totalPrice * PAYPAL_NPR_TO_USD);

      if (data?.status !== "COMPLETED" || capturedAmount !== expectedAmount) {
        await restoreReservedStockOnce(order);
        order.paymentStatus = "Failed";
        order.status = "cancelled";
        await order.save();
        const { response, statusCode } = createErrorResponse(
          "PayPal payment could not be verified",
          HTTP_STATUS.BAD_REQUEST,
        );
        res.status(statusCode).json(response);
        return;
      }

      order.isPaid = true;
      order.paidAt = order.paidAt || new Date();
      order.paymentStatus = "Completed";
      order.paymentTransactionId =
        data?.purchase_units?.[0]?.payments?.captures?.[0]?.id || undefined;
      order.status = order.status === "pending" ? "processing" : order.status;
      await order.save();

      const { response, statusCode } = createSuccessResponse(
        order,
        "PayPal payment verified successfully",
      );
      res.status(statusCode).json(response);
    } catch (error: any) {
      console.error("PayPal verification error:", error);
      const { response, statusCode } = createErrorResponse(
        error.message || "Payment verification failed",
        HTTP_STATUS.BAD_REQUEST,
      );
      res.status(statusCode).json(response);
    }
  };
}

export { PAYPAL_NPR_TO_USD, restoreReservedStockOnce };
export default new PaymentController();
