// Inventário (somente leitura): de onde veio cada lançamento do banco.
// Uso: node --env-file=<arquivo com DATABASE_URL> scripts/inventory.js
import { openDb } from "../src/db.js";

const db = await openDb();
const brl = (c) => (Number(c) / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

const imports = await db.query(
  `SELECT i.id, i.file_name, i.document_type, i.institution, i.period_start, i.period_end,
          to_char(i.created_at,'DD/MM HH24:MI') AS quando,
          COUNT(t.id)::int AS n, COUNT(t.external_id)::int AS com_of
   FROM imports i LEFT JOIN transactions t ON t.import_id = i.id
   GROUP BY i.id ORDER BY i.id`);
console.log("Arquivos importados (PDF/foto/CSV):");
for (const i of imports) {
  console.log(`  #${i.id} ${i.quando}  ${i.document_type.padEnd(8)} ${String(i.institution || "?").padEnd(22)} ${i.period_start || "?"} a ${i.period_end || "?"}  ${i.n} lançamento(s), ${i.com_of} confirmados pelo Open Finance  [${i.file_name}]`);
}

const groups = await db.query(
  `SELECT CASE
            WHEN import_id IS NOT NULL THEN 'arquivo'
            WHEN source = 'manual' THEN 'manual'
            WHEN external_id IS NOT NULL THEN 'open finance'
            ELSE 'outro' END AS origem,
          (external_id IS NOT NULL) AS tem_of,
          COUNT(*)::int AS n, MIN(date) AS de, MAX(date) AS ate
   FROM transactions GROUP BY 1, 2 ORDER BY 1, 2`);
console.log("\nLançamentos por origem:");
for (const g of groups) console.log(`  ${g.origem.padEnd(13)} ${g.tem_of ? "(com id Open Finance)" : "(sem id Open Finance)"}  ${String(g.n).padStart(4)}  de ${g.de} a ${g.ate}`);

const acc = await db.query(
  `SELECT COALESCE(account, '(sem conta)') AS conta, source, COUNT(*)::int AS n FROM transactions
   WHERE external_id IS NOT NULL AND import_id IS NULL GROUP BY 1, 2 ORDER BY 1, 2`);
console.log("\nVindos só do Open Finance, por conta:");
for (const a of acc) console.log(`  ${a.conta.padEnd(22)} ${a.source.padEnd(8)} ${a.n}`);

const [pend] = await db.query("SELECT COUNT(*)::int AS n FROM pending_imports");
console.log(`\nPrévias de upload não confirmadas: ${pend.n}`);
