import { getActivePrompt, getSimulationCases } from "@/lib/db";
import { generateJson, generateText } from "@/lib/openai";

(async () => {
  const prompt = await getActivePrompt();
  const cases = await getSimulationCases(20);

  const rows = [] as Array<{ input: string; score: number; notes: string; answer: string }>;
  for (const c of cases) {
    const answer = await generateText(`Usuário: ${c.input}`, prompt.promptText);
    const evalJson = await generateJson<{ score: number; notes: string }>(
      `Entrada: ${c.input}\nResposta: ${answer}\nEsperado: ${c.expected}`,
      "Avalie resposta da Iara de 0 a 1 e retorne JSON {score, notes}."
    );

    rows.push({
      input: c.input,
      score: evalJson.score,
      notes: evalJson.notes,
      answer
    });
  }

  console.log(JSON.stringify({ promptVersion: prompt.version, rows }, null, 2));
})();
