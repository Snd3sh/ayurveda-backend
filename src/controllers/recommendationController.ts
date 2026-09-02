import { Request, Response } from "express";
import Product from "../models/Product";
import { createErrorResponse, createSuccessResponse } from "../utils";
import { HTTP_STATUS } from "../constant";

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function buildDocument(product: any): string {
  // Repeat the category so category similarity has meaningful weight.
  return `${product.name} ${product.description} ${product.category} ${product.category}`;
}

function termFrequency(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) || 0) + 1);
  const total = tokens.length || 1;
  for (const [term, count] of counts) counts.set(term, count / total);
  return counts;
}

function cosineSimilarity(
  a: Map<string, number>,
  b: Map<string, number>,
  idf: Map<string, number>,
): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const terms = new Set([...a.keys(), ...b.keys()]);

  for (const term of terms) {
    const weight = idf.get(term) || 1;
    const av = (a.get(term) || 0) * weight;
    const bv = (b.get(term) || 0) * weight;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }

  if (!normA || !normB) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

class RecommendationController {
  getRecommendations = async (req: Request, res: Response): Promise<void> => {
    try {
      const { productId } = req.params;
      const limit = Math.min(Math.max(Number(req.query.limit) || 6, 1), 12);

      const products = await Product.find({}).lean();
      const target = products.find((p: any) => p._id.toString() === productId);

      if (!target) {
        const { response, statusCode } = createErrorResponse(
          "Product not found",
          HTTP_STATUS.NOT_FOUND,
        );
        res.status(statusCode).json(response);
        return;
      }

      const documents = products.map((product: any) =>
        tokenize(buildDocument(product)),
      );
      const documentFrequency = new Map<string, number>();

      for (const tokens of documents) {
        for (const term of new Set(tokens)) {
          documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1);
        }
      }

      const totalDocuments = documents.length || 1;
      const idf = new Map<string, number>();
      for (const [term, df] of documentFrequency) {
        idf.set(term, Math.log((totalDocuments + 1) / (df + 1)) + 1);
      }

      const targetTf = termFrequency(tokenize(buildDocument(target)));

      const recommendations = products
        .filter(
          (product: any) =>
            product._id.toString() !== productId && product.stock > 0,
        )
        .map((product: any) => {
          const similarity = cosineSimilarity(
            targetTf,
            termFrequency(tokenize(buildDocument(product))),
            idf,
          );

          // Small category boost makes recommendations more useful for an e-commerce catalogue.
          const categoryBoost = product.category === target.category ? 0.08 : 0;
          return {
            ...product,
            recommendationScore: Number(
              (similarity + categoryBoost).toFixed(4),
            ),
          };
        })
        .sort((a: any, b: any) => b.recommendationScore - a.recommendationScore)
        .slice(0, limit);

      const { response, statusCode } = createSuccessResponse(
        recommendations,
        "Recommendations generated successfully",
      );
      res.status(statusCode).json(response);
    } catch (error: any) {
      console.error("Recommendation error:", error);
      const { response, statusCode } = createErrorResponse(
        error.message || "Failed to generate recommendations",
        HTTP_STATUS.INTERNAL_SERVER_ERROR,
      );
      res.status(statusCode).json(response);
    }
  };
}

export default new RecommendationController();
