import { Request, Response } from "express";
import mongoose from "mongoose";
import Order from "../models/Order";
import Product from "../models/Product";
import { createSuccessResponse, createErrorResponse } from "../utils";
import { HTTP_STATUS, API_MESSAGES } from "../constant";
import { AuthRequest } from "../middleware/auth";
import { createPayPalOrder } from "./paymentController";

const SHIPPING_FEE = Number(process.env.SHIPPING_FEE || 100);
const TAX_RATE = Number(process.env.TAX_RATE || 0);

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

class OrderController {
  createOrder = async (req: Request, res: Response): Promise<void> => {
    try {
      const authReq = req as AuthRequest;
      const user = authReq.user;
      if (!user?.email) {
        const { response, statusCode } = createErrorResponse(
          "User not authenticated",
          HTTP_STATUS.UNAUTHORIZED,
        );
        res.status(statusCode).json(response);
        return;
      }

      const {
        orderItems,
        shippingAddress,
        paymentMethod = "cash_on_delivery",
      } = req.body;

      if (!Array.isArray(orderItems) || orderItems.length === 0) {
        const { response, statusCode } = createErrorResponse(
          "Order must contain at least one item",
          HTTP_STATUS.BAD_REQUEST,
        );
        res.status(statusCode).json(response);
        return;
      }

      if (!shippingAddress || shippingAddress.country !== "Nepal") {
        const { response, statusCode } = createErrorResponse(
          "We currently only deliver within Nepal",
          HTTP_STATUS.BAD_REQUEST,
        );
        res.status(statusCode).json(response);
        return;
      }

      const allowedCities = ["Kathmandu", "Pokhara"];
      if (!allowedCities.includes(shippingAddress.city)) {
        const { response, statusCode } = createErrorResponse(
          "Delivery is only available in Kathmandu and Pokhara",
          HTTP_STATUS.BAD_REQUEST,
        );
        res.status(statusCode).json(response);
        return;
      }

      if (!["cash_on_delivery", "paypal"].includes(paymentMethod)) {
        const { response, statusCode } = createErrorResponse(
          "Unsupported payment method",
          HTTP_STATUS.BAD_REQUEST,
        );
        res.status(statusCode).json(response);
        return;
      }

      // Never trust name/image/price/totals supplied by the browser.
      const normalizedItems: Array<{
        product: mongoose.Types.ObjectId;
        name: string;
        quantity: number;
        price: number;
        image: string;
      }> = [];
      let itemsPrice = 0;

      // Merge duplicate product IDs before reserving stock.
      const quantities = new Map<string, number>();
      for (const item of orderItems) {
        if (!mongoose.isValidObjectId(item.product)) {
          const { response, statusCode } = createErrorResponse(
            "Invalid product ID",
            HTTP_STATUS.BAD_REQUEST,
          );
          res.status(statusCode).json(response);
          return;
        }
        const quantity = Number(item.quantity);
        if (!Number.isInteger(quantity) || quantity < 1) {
          const { response, statusCode } = createErrorResponse(
            "Invalid product quantity",
            HTTP_STATUS.BAD_REQUEST,
          );
          res.status(statusCode).json(response);
          return;
        }
        const key = item.product.toString();
        quantities.set(key, (quantities.get(key) || 0) + quantity);
      }

      // Atomically reserve stock. This prevents two simultaneous orders from overselling.
      const reserved: Array<{ productId: string; quantity: number }> = [];
      try {
        for (const [productId, quantity] of quantities) {
          const product = await Product.findOneAndUpdate(
            { _id: productId, stock: { $gte: quantity } },
            { $inc: { stock: -quantity } },
            { new: true },
          );

          if (!product) {
            throw new Error(
              `Insufficient stock or product not found for ${productId}`,
            );
          }

          reserved.push({ productId, quantity });
          normalizedItems.push({
            product: product._id,
            name: product.name,
            quantity,
            price: product.price,
            image: product.image,
          });
          itemsPrice += product.price * quantity;
        }
      } catch (reservationError) {
        for (const item of reserved) {
          await Product.findByIdAndUpdate(item.productId, {
            $inc: { stock: item.quantity },
          });
        }
        throw reservationError;
      }

      itemsPrice = roundMoney(itemsPrice);
      const shippingPrice = roundMoney(SHIPPING_FEE);
      const taxPrice = roundMoney(itemsPrice * (TAX_RATE / 100));
      const totalPrice = roundMoney(itemsPrice + shippingPrice + taxPrice);

      const order = new Order({
        orderItems: normalizedItems,
        shippingAddress,
        paymentMethod,
        paymentGateway: paymentMethod === "paypal" ? "paypal" : undefined,
        paymentStatus: paymentMethod === "paypal" ? "Created" : undefined,
        itemsPrice,
        shippingPrice,
        taxPrice,
        totalPrice,
        user: { id: user.id, name: user.name, email: user.email },
        status: "pending",
        isPaid: paymentMethod === "cash_on_delivery" ? false : false,
      });

      try {
        await order.save();
      } catch (saveError) {
        for (const item of reserved) {
          await Product.findByIdAndUpdate(item.productId, {
            $inc: { stock: item.quantity },
          });
        }
        throw saveError;
      }

      // For PayPal, create the payment from the server. The PayPal secret never reaches the browser.
      if (paymentMethod === "paypal") {
        try {
          const paypal = await createPayPalOrder({
            orderId: order._id.toString(),
            totalNpr: totalPrice,
          });

          order.paypalOrderId = paypal.paypalOrderId;
          order.paymentStatus = "Created";
          await order.save();

          const { response, statusCode } = createSuccessResponse(
            {
              order,
              approvalUrl: paypal.approvalUrl,
              paypalOrderId: paypal.paypalOrderId,
            },
            "Order created. Redirect user to PayPal Sandbox.",
            HTTP_STATUS.CREATED,
          );
          res.status(statusCode).json(response);
          return;
        } catch (paypalError: any) {
          await this.restoreStockAndCancel(
            order._id.toString(),
            "Unable to initiate PayPal payment",
          );
          const { response, statusCode } = createErrorResponse(
            paypalError.message || "Unable to initiate PayPal payment",
            HTTP_STATUS.BAD_REQUEST,
          );
          res.status(statusCode).json(response);
          return;
        }
      }

      const { response, statusCode } = createSuccessResponse(
        order,
        API_MESSAGES.ORDER_CREATED,
        HTTP_STATUS.CREATED,
      );
      res.status(statusCode).json(response);
    } catch (error: any) {
      console.error("Error creating order:", error);
      const { response, statusCode } = createErrorResponse(
        error.message || "Failed to create order",
        HTTP_STATUS.BAD_REQUEST,
      );
      res.status(statusCode).json(response);
    }
  };

  getMyOrders = async (req: Request, res: Response): Promise<void> => {
    try {
      const user = (req as AuthRequest).user;
      if (!user?.email) {
        const { response, statusCode } = createErrorResponse(
          "User not authenticated",
          HTTP_STATUS.UNAUTHORIZED,
        );
        res.status(statusCode).json(response);
        return;
      }

      const orders = await Order.find({ "user.email": user.email })
        .sort({ createdAt: -1 })
        .populate("orderItems.product");

      const { response, statusCode } = createSuccessResponse(
        orders,
        "Your orders retrieved successfully",
      );
      res.status(statusCode).json(response);
    } catch (error) {
      console.error("Error fetching user orders:", error);
      const { response, statusCode } = createErrorResponse(
        "Internal server error",
      );
      res.status(statusCode).json(response);
    }
  };

  getAllOrders = async (req: Request, res: Response): Promise<void> => {
    try {
      const orders = await Order.find({})
        .sort({ createdAt: -1 })
        .populate("orderItems.product");
      const { response, statusCode } = createSuccessResponse(
        orders,
        "Orders retrieved successfully",
      );
      res.status(statusCode).json(response);
    } catch (error) {
      console.error("Error fetching orders:", error);
      const { response, statusCode } = createErrorResponse(
        "Internal server error",
      );
      res.status(statusCode).json(response);
    }
  };

  getOrderById = async (req: Request, res: Response): Promise<void> => {
    try {
      const user = (req as AuthRequest).user;
      const { id } = req.params;
      const order = await Order.findById(id).populate("orderItems.product");

      if (!order) {
        const { response, statusCode } = createErrorResponse(
          API_MESSAGES.ORDER_NOT_FOUND,
          HTTP_STATUS.NOT_FOUND,
        );
        res.status(statusCode).json(response);
        return;
      }

      const isAdmin =
        user?.role === "admin" ||
        (process.env.ADMIN_EMAILS || "")
          .split(",")
          .map((e) => e.trim())
          .includes(user?.email || "");
      if (!isAdmin && order.user.email !== user?.email) {
        const { response, statusCode } = createErrorResponse(
          "You can only access your own orders",
          HTTP_STATUS.FORBIDDEN,
        );
        res.status(statusCode).json(response);
        return;
      }

      const { response, statusCode } = createSuccessResponse(
        order,
        "Order retrieved successfully",
      );
      res.status(statusCode).json(response);
    } catch (error) {
      console.error("Error fetching order:", error);
      const { response, statusCode } = createErrorResponse(
        "Internal server error",
      );
      res.status(statusCode).json(response);
    }
  };

  updateOrder = async (req: Request, res: Response): Promise<void> => {
    try {
      const { id } = req.params;
      const allowedFields = ["status", "isDelivered", "deliveredAt"];
      const updateData: Record<string, any> = {};
      for (const field of allowedFields) {
        if (req.body[field] !== undefined) updateData[field] = req.body[field];
      }

      if (updateData.status === "delivered") {
        updateData.isDelivered = true;
        updateData.deliveredAt = new Date();
      }

      const order = await Order.findByIdAndUpdate(id, updateData, {
        new: true,
        runValidators: true,
      });
      if (!order) {
        const { response, statusCode } = createErrorResponse(
          API_MESSAGES.ORDER_NOT_FOUND,
          HTTP_STATUS.NOT_FOUND,
        );
        res.status(statusCode).json(response);
        return;
      }

      const { response, statusCode } = createSuccessResponse(
        order,
        API_MESSAGES.ORDER_UPDATED,
      );
      res.status(statusCode).json(response);
    } catch (error: any) {
      console.error("Error updating order:", error);
      const { response, statusCode } = createErrorResponse(
        error.message || "Failed to update order",
        HTTP_STATUS.BAD_REQUEST,
      );
      res.status(statusCode).json(response);
    }
  };

  deleteOrder = async (req: Request, res: Response): Promise<void> => {
    try {
      const { id } = req.params;
      const order = await Order.findById(id);
      if (!order) {
        const { response, statusCode } = createErrorResponse(
          API_MESSAGES.ORDER_NOT_FOUND,
          HTTP_STATUS.NOT_FOUND,
        );
        res.status(statusCode).json(response);
        return;
      }

      if (!order.isPaid && order.status !== "cancelled") {
        await this.restoreReservedStock(order);
      }
      await Order.findByIdAndDelete(id);

      const { response, statusCode } = createSuccessResponse(
        null,
        "Order deleted successfully",
      );
      res.status(statusCode).json(response);
    } catch (error: any) {
      console.error("Error deleting order:", error);
      const { response, statusCode } = createErrorResponse(
        error.message || "Failed to delete order",
        HTTP_STATUS.BAD_REQUEST,
      );
      res.status(statusCode).json(response);
    }
  };

  private restoreReservedStock = async (order: any): Promise<void> => {
    for (const item of order.orderItems) {
      await Product.findByIdAndUpdate(item.product, {
        $inc: { stock: item.quantity },
      });
    }
  };

  private restoreStockAndCancel = async (
    orderId: string,
    reason: string,
  ): Promise<void> => {
    const order = await Order.findById(orderId);
    if (!order || order.status === "cancelled") return;
    await this.restoreReservedStock(order);
    order.status = "cancelled";
    order.paymentStatus = "Failed";
    await order.save();
    console.warn(`[Order ${orderId}] cancelled: ${reason}`);
  };
}

export default OrderController;
