// Confere a conexão com o banco da nuvem (DATABASE_URL) e cria as tabelas se faltarem.
// Uso: node --env-file=<arquivo com DATABASE_URL> scripts/check-db.js
import { openDb } from "../src/db.js";
import { monthSummary } from "../src/summary.js";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL não definida.");
  process.exit(1);
}
const db = await openDb({ url: process.env.DATABASE_URL });
const tables = await db.query(
  "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1");
const s = await monthSummary(db, new Date().toISOString().slice(0, 7));
console.log(`Banco OK. Tabelas: ${tables.map((t) => t.table_name).join(", ")}. Lançamentos recentes no mês: ${s.recent.length}.`);
