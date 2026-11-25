// Cria um banco de DEMONSTRAÇÃO local (data/demo-pg) para ver o dashboard sem importar nada.
// Uso:  npm run demo   e depois inicie com PGLITE_DIR=data/demo-pg
import fs from "node:fs";
import { openDb } from "../src/db.js";

const dir = "data/demo-pg";
fs.rmSync(dir, { recursive: true, force: true });
const db = await openDb({ url: "", dataDir: dir });

let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const today = new Date();
const pad = (n) => String(n).padStart(2, "0");
const rows = [];
const ins = (...r) => rows.push(r);

for (let back = 5; back >= 0; back--) {
  const d = new Date(today.getFullYear(), today.getMonth() - back, 1);
  const ym = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  const lastDay = back === 0 ? today.getDate() : new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  const day = (n) => `${ym}-${pad(Math.min(n, lastDay))}`;

  if (lastDay >= 5) ins(day(5), "Salário ACME", 614960, "entrada", "Salário", "holerite", 0);
  if (back % 2 === 0 && lastDay >= 20) ins(day(20), "Freela design", 80000 + Math.round(rnd() * 60000), "entrada", "Outras receitas", "extrato", 0);
  if (lastDay >= 7) ins(day(7), "Aluguel", 220000, "saida", "Moradia", "extrato", 0);
  if (lastDay >= 10) ins(day(10), "Conta de luz", 18000 + Math.round(rnd() * 8000), "saida", "Contas e serviços", "extrato", 0);
  if (lastDay >= 12) ins(day(12), "Pagamento fatura Nubank", 150000, "saida", "Transferência", "extrato", 1);
  ins(day(3), "Netflix", 5590, "saida", "Assinaturas", "fatura", 0);
  ins(day(3), "Spotify", 2190, "saida", "Assinaturas", "fatura", 0);

  const shops = [
    ["Supermercado Dia", "Mercado", 9000, 35000], ["iFood", "Alimentação", 3500, 9000],
    ["Uber", "Transporte", 1500, 4500], ["Posto Shell", "Transporte", 15000, 25000],
    ["Farmácia Drogasil", "Saúde", 2500, 12000], ["Cinema", "Lazer", 4000, 9000],
    ["Amazon", "Compras", 5000, 30000], ["Padaria", "Alimentação", 1200, 3500],
  ];
  for (let k = 0; k < 26; k++) {
    const [desc, cat, min, max] = shops[Math.floor(rnd() * shops.length)];
    const manual = back === 0 && k % 9 === 0;
    ins(day(1 + Math.floor(rnd() * lastDay)), desc, min + Math.round(rnd() * (max - min)), "saida", cat, manual ? "manual" : "fatura", 0);
  }
}

await db.batch(rows.map((params) => ({
  sql: `INSERT INTO transactions (date, description, amount_cents, direction, category, source, is_transfer)
        VALUES ($1, $2, $3, $4, $5, $6, $7)`,
  params,
})));
await db.close?.();
console.log(`Banco de demonstração criado em ${dir} (${rows.length} lançamentos).`);
