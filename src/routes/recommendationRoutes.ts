import { Router } from "express";
import recommendationController from "../controllers/recommendationController";

const router: Router = Router();

router.get("/:productId", recommendationController.getRecommendations);

export default router;
