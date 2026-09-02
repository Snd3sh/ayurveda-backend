import { Router } from "express";
import OrderController from "../controllers/orderController";
import { adminAuth } from "../middleware/adminAuth";
import { requireAuth } from "../middleware/auth";

const router: Router = Router();
const orderController = new OrderController();

// Customer routes
router.post("/", requireAuth, orderController.createOrder);
router.get("/my", requireAuth, orderController.getMyOrders);
router.get("/:id", requireAuth, orderController.getOrderById);

// Admin routes
router.get("/", adminAuth, orderController.getAllOrders);
router.put("/:id", adminAuth, orderController.updateOrder);
router.delete("/:id", adminAuth, orderController.deleteOrder);

export default router;
