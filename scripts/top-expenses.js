// Diagnóstico: maiores saídas de um mês e possíveis duplicidades (mesmo valor, datas próximas).
// Uso: node --env-file=<arquivo com DATABASE_URL> scripts/top-expenses.js 2026-11
import { openDb } from "../src/db.js";

const month = process.argv[2] || new Date().toISOString().slice(0, 7);
const db = await openDb();
const brl = (c) => (c / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

const top = await db.query(
  `SELECT date, description, amount_cents, source, is_transfer, category, (external_id IS NOT NULL) AS of, (import_id IS NOT NULL) AS pdf
   FROM transactions WHERE direction='saida' AND substr(date,1,7)=$1 ORDER BY amount_cents DESC LIMIT 12`, [month]);
console.log(`Maiores saídas de ${month}:`);
for (const t of top) {
  console.log(`  ${t.date}  ${brl(t.amount_cents).padStart(14)}  ${t.source.padEnd(8)} ${t.is_transfer ? "TRANSF " : "       "}${t.category.padEnd(18)} ${t.of ? "[OF]" : "    "}${t.pdf ? "[PDF]" : "     "} ${t.description}`);
}

const dups = await db.query(
  `SELECT a.date AS d1, b.date AS d2, a.amount_cents, a.description AS a_desc, b.description AS b_desc, a.source AS s1, b.source AS s2
   FROM transactions a JOIN transactions b ON a.id < b.id AND a.amount_cents = b.amount_cents AND a.direction = b.direction
     AND abs(a.date::date - b.date::date) <= 3
   WHERE substr(a.date,1,7)=$1 AND a.direction='saida' AND a.is_transfer=0 AND b.is_transfer=0`, [month]);
console.log(`\nPares com mesmo valor e datas próximas (${dups.length}):`);
for (const d of dups) console.log(`  ${brl(d.amount_cents)}  ${d.d1} ${d.s1}: ${d.a_desc}  |  ${d.d2} ${d.s2}: ${d.b_desc}`);

const t = await db.query(
  `SELECT source, is_transfer, COUNT(*)::int n, SUM(amount_cents)::int total FROM transactions
   WHERE direction='saida' AND substr(date,1,7)=$1 GROUP BY 1,2 ORDER BY 1,2`, [month]);
console.log("\nSaídas por origem:");
for (const r of t) console.log(`  ${r.source.padEnd(8)} ${r.is_transfer ? "transferência" : "gasto        "} ${String(r.n).padStart(3)}  ${brl(r.total)}`);
