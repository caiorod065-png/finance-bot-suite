import { env } from "@/lib/env";

export interface ValidatorResult {
  endpoint: string;
  pass: boolean;
  score: number;
  notes?: string;
}

export async function runExternalValidators(input: {
  candidatePrompt: string;
  baselinePrompt: string;
  qualitySignals: string[];
  runId: string;
}): Promise<ValidatorResult[]> {
  const endpoints = (env.VALIDATOR_AGENT_ENDPOINTS ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

  if (!endpoints.length) return [];

  const results = await Promise.all(
    endpoints.map(async (endpoint) => {
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(env.VALIDATOR_AGENT_BEARER
              ? { Authorization: `Bearer ${env.VALIDATOR_AGENT_BEARER}` }
              : {})
          },
          body: JSON.stringify(input)
        });

        if (!response.ok) {
          return {
            endpoint,
            pass: false,
            score: 0,
            notes: `HTTP ${response.status}`
          };
        }

        const json = (await response.json()) as Partial<ValidatorResult>;
        return {
          endpoint,
          pass: Boolean(json.pass),
          score: Number(json.score ?? 0),
          notes: json.notes
        };
      } catch (error) {
        return {
          endpoint,
          pass: false,
          score: 0,
          notes: error instanceof Error ? error.message : "unknown_error"
        };
      }
    })
  );

  return results;
}
