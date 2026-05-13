import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import archiver from "archiver";
import { env } from "@/lib/env";
import { listProjectFiles } from "@/lib/utils";

async function createZip(projectRoot: string): Promise<string> {
  const filename = `iara-autopilot-${Date.now()}.zip`;
  const zipPath = path.join(os.tmpdir(), filename);

  await new Promise<void>((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    output.on("close", () => resolve());
    archive.on("error", reject);

    archive.pipe(output);

    for (const file of listProjectFiles(projectRoot)) {
      const rel = path.relative(projectRoot, file);
      archive.file(file, { name: rel });
    }

    archive.finalize().catch(reject);
  });

  return zipPath;
}

function toVercelFileData(content: Buffer): string {
  return content.toString("base64");
}

async function createDeploymentWithFiles(projectRoot: string): Promise<{ id: string; url?: string }> {
  if (!env.VERCEL_TOKEN || !env.VERCEL_PROJECT_ID) {
    throw new Error("VERCEL_TOKEN e VERCEL_PROJECT_ID são obrigatórios para deploy por API.");
  }

  const files = listProjectFiles(projectRoot)
    .map((full) => ({
      file: path.relative(projectRoot, full),
      data: toVercelFileData(fs.readFileSync(full))
    }))
    .filter((f) => !f.file.startsWith(".") || f.file === ".gitignore");

  const payload: Record<string, unknown> = {
    name: "iara-autopilot",
    project: env.VERCEL_PROJECT_ID,
    target: env.VERCEL_ENV_TARGET,
    files,
    meta: {
      source: "iara-self-improver"
    }
  };

  if (env.VERCEL_TEAM_ID) payload.teamId = env.VERCEL_TEAM_ID;

  const res = await fetch("https://api.vercel.com/v13/deployments", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.VERCEL_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Falha no deploy Vercel API: HTTP ${res.status} - ${err}`);
  }

  const json = (await res.json()) as { id: string; url?: string };
  return { id: json.id, url: json.url };
}

async function triggerDeployHook(): Promise<{ id: string; url?: string }> {
  if (!env.VERCEL_DEPLOY_HOOK_URL) {
    throw new Error("VERCEL_DEPLOY_HOOK_URL não configurado.");
  }

  const response = await fetch(env.VERCEL_DEPLOY_HOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source: "iara-self-improver", timestamp: new Date().toISOString() })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Falha no Deploy Hook Vercel: HTTP ${response.status} - ${err}`);
  }

  const text = await response.text();
  return { id: `hook-${Date.now()}`, url: text || undefined };
}

export async function deployToVercel(projectRoot: string): Promise<{ deploymentId: string; deploymentUrl?: string; zipPath: string }> {
  const zipPath = await createZip(projectRoot);

  // Estratégia:
  // 1) Se houver deploy hook, dispara hook (mais robusto para projeto ligado ao Git)
  // 2) Senão, usa Vercel Deployments API com upload de arquivos
  let deployment;
  if (env.VERCEL_DEPLOY_HOOK_URL) {
    deployment = await triggerDeployHook();
  } else {
    deployment = await createDeploymentWithFiles(projectRoot);
  }

  return {
    deploymentId: deployment.id,
    deploymentUrl: deployment.url,
    zipPath
  };
}
