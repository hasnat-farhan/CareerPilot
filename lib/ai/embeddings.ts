/**
 * Thin re-export so existing callers (CV ingester, RAG retrieval) keep
 * importing from "@/lib/ai/embeddings" while the real implementation lives
 * in provider.ts. New code should import from "@/lib/ai/provider" directly.
 */

export { embedText, embedBatch, AI_CONFIG } from "./provider";
