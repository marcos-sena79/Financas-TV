// Ponto de entrada. Na Vercel, o "export default" vira a função serverless.
// No PC (`npm start`), sobe um servidor normal na rede de casa e serve a pasta public/.
import express from "express";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";

const app = createApp();
export default app;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  app.use(express.static(path.join(here, "..", "public")));
  const port = Number(process.env.PORT || 3000);
  app.listen(port, "0.0.0.0", () => {
    const ips = Object.values(os.networkInterfaces()).flat()
      .filter((i) => i && i.family === "IPv4" && !i.internal).map((i) => i.address);
    console.log("\nFinanças rodando!");
    for (const ip of ips.length ? ips : ["localhost"]) {
      console.log(`  App (celular):  http://${ip}:${port}/`);
      console.log(`  Dashboard (TV): http://${ip}:${port}/tv`);
    }
    console.log(`  Banco: ${process.env.DATABASE_URL ? "Neon (DATABASE_URL)" : "local (data/pgdata)"}`);
    if (!process.env.APP_PASSWORD) console.log("  Sem APP_PASSWORD: acesso sem senha (ok só na rede de casa).");
    if (!process.env.OPENROUTER_API_KEY) console.log("  Atenção: OPENROUTER_API_KEY não definida - a leitura de arquivos não vai funcionar.");
  });
}
