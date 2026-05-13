import OpenAI from "openai";
import { assertRuntimeEnv, env } from "@/lib/env";

export const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

export async function generateText(input: string, instructions?: string): Promise<string> {
  assertRuntimeEnv();
  const response = await openai.responses.create({
    model: env.OPENAI_MODEL,
    instructions,
    input,
    temperature: 0.6
  });

  return response.output_text?.trim() ?? "";
}

export async function generateJson<T>(input: string, instructions: string): Promise<T> {
  assertRuntimeEnv();
  const response = await openai.responses.create({
    model: env.OPENAI_MODEL,
    instructions,
    input,
    temperature: 0.2,
    text: { format: { type: "json_object" } }
  });

  const content = response.output_text?.trim();
  if (!content) {
    throw new Error("Model returned empty JSON output");
  }

  return JSON.parse(content) as T;
}

export async function embed(text: string): Promise<number[]> {
  assertRuntimeEnv();
  const response = await openai.embeddings.create({
    model: env.OPENAI_EMBEDDING_MODEL,
    input: text
  });

  return response.data[0]?.embedding ?? [];
}
