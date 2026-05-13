import { env } from "@/lib/env";
import { embed } from "@/lib/openai";
import { cosineSimilarity } from "@/lib/utils";

export interface RagItem {
  id: string;
  text: string;
  score: number;
}

export async function retrieveSimilarErrorPatterns(input: {
  query: string;
  pool: Array<{ id: string; text: string; embedding?: number[] | null }>;
}): Promise<RagItem[]> {
  if (!input.pool.length) return [];

  const queryEmbedding = await embed(input.query);
  const scored = input.pool
    .map((item) => {
      const score = item.embedding?.length ? cosineSimilarity(queryEmbedding, item.embedding) : 0;
      return { id: item.id, text: item.text, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, env.RAG_TOP_K);

  return scored;
}
