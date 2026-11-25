// Conecta seus bancos do Meu Pluggy ao app e grava os ids em PLUGGY_ITEM_IDS no .env.
// Uso:  npm run pluggy:connect
// Pré-requisitos: bancos já conectados em https://meu.pluggy.ai, conector MeuPluggy habilitado
// na sua aplicação em https://dashboard.pluggy.ai, e PLUGGY_CLIENT_ID / PLUGGY_CLIENT_SECRET no .env.
import fs from "node:fs";
import readline from "node:readline/promises";
import { spawn } from "node:child_process";
import { connectMeuPluggy, LinkExpiredError } from "../src/pluggy.js";
let expiredRetries = 0;

const ENV_FILE = ".env";

function saveItemId(id) {
  const text = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf8") : "";
  const lines = text.split(/\r?\n/);
  const idx = lines.findIndex((l) => /^\s*PLUGGY_ITEM_IDS\s*=/.test(l));
  if (idx >= 0) {
    const current = lines[idx].replace(/^\s*PLUGGY_ITEM_IDS\s*=\s*/, "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!current.includes(id)) current.push(id);
    lines[idx] = `PLUGGY_ITEM_IDS=${current.join(",")}`;
  } else {
    while (lines.length && lines.at(-1) === "") lines.pop();
    lines.push(`PLUGGY_ITEM_IDS=${id}`);
  }
  fs.writeFileSync(ENV_FILE, lines.join("\n") + "\n");
  return lines.find((l) => l.startsWith("PLUGGY_ITEM_IDS=")).split("=")[1].split(",").length;
}

function openBrowser(url) {
  try {
    if (process.platform === "win32") spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    else spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
  } catch {}
}

// Para retomar uma conexão já criada:  npm run pluggy:connect -- <id-da-conexão>
let existingItemId = process.argv[2] || null;
console.log("\nConectar bancos do Meu Pluggy ao app de finanças\n");

let again = true;
while (again) {
  try {
    const res = await connectMeuPluggy({
      existingItemId,
      onItem: (id) => console.log(`  Id da conexão: ${id}`),
      onStatus: (m) => console.log(`  [${new Date().toLocaleTimeString("pt-BR")}] ${m}`),
      onUrl: (url, expires) => {
        const until = expires ? ` (válido até ${expires.toLocaleTimeString("pt-BR")} - seja rápido!)` : "";
        console.log(`\n  Abra este link, entre no Meu Pluggy e autorize o banco${until}:\n`);
        console.log("  " + url + "\n");
        openBrowser(url);
      },
    });
    const total = saveItemId(res.id);
    console.log(`\n  ✓ Conectado! Contas: ${res.contas.join(", ") || "(nenhuma ainda - o banco pode estar sincronizando)"}`);
    console.log(`  Id salvo no .env (PLUGGY_ITEM_IDS agora tem ${total} conexão(ões)).`);
  } catch (e) {
    console.error(`\n  ✗ ${e.message}`);
    if (e instanceof LinkExpiredError && expiredRetries++ < 3) {
      console.log("  Gerando um link novo… feche as abas antigas do Meu Pluggy e use só o próximo link.\n");
      existingItemId = null;
      continue;
    }
  }
  existingItemId = null;
  // Só abre o teclado na hora da pergunta, para o Ctrl-C funcionar durante a espera.
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ans = await rl.question("\nConectar outro banco? (s/N) ");
  rl.close();
  again = /^s/i.test(ans.trim());
}
console.log("\nPronto. Avise o Claude para enviar as credenciais à Vercel e sincronizar.\n");
