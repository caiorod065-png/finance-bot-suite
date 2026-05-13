import { runSelfImprovement } from "@/lib/self-improve";

(async () => {
  const result = await runSelfImprovement("cli-manual");
  console.log(JSON.stringify(result, null, 2));
})();
