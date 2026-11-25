// Diagnóstico: como os textos parecidos com pagamento de fatura foram classificados (Open Finance).
// Uso: node --env-file=<arquivo com DATABASE_URL> scripts/check-transfers.js
import { openDb } from "../src/db.js";

const db = await openDb();
const rows = await db.query(
  `SELECT regexp_replace(description, '\\s*-?\\s*DOCTO.*$', '') AS texto, source, direction, is_transfer,
          COUNT(*)::int AS n, SUM(amount_cents)::int AS total
   FROM transactions
   WHERE external_id IS NOT NULL
     AND (description ~* 'cart|fatura|pagto|pagamento|aplica|resgate|invest|transf' )
   GROUP BY 1, 2, 3, 4 ORDER BY total DESC LIMIT 25`);
for (const r of rows) {
  console.log(`${r.is_transfer ? "TRANSF" : "gasto "}  ${r.source.padEnd(7)} ${r.direction.padEnd(7)} ${String(r.n).padStart(3)}x  R$ ${(r.total / 100).toFixed(2).padStart(10)}  ${r.texto}`);
}
