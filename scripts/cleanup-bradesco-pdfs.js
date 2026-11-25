// Limpeza pedida em 23/11/2026: remove o que veio de PDFs do Bradesco (o Bradesco passa a vir só do
// Open Finance) e desfaz ligações erradas de transações do Pluggy com lançamentos de outros bancos.
// Uso: node --env-file=<arquivo com DATABASE_URL> scripts/cleanup-bradesco-pdfs.js [--apply]
//      sem --apply só mostra o que seria feito.
import { openDb } from "../src/db.js";

const apply = process.argv.includes("--apply");
const db = await openDb();

const imports = await db.query(
  `SELECT i.id, i.file_name, i.document_type, COUNT(t.id)::int AS n
   FROM imports i LEFT JOIN transactions t ON t.import_id = i.id
   WHERE i.institution ILIKE '%bradesco%' GROUP BY i.id ORDER BY i.id`);
const ids = imports.map((i) => i.id);
const total = imports.reduce((s, i) => s + i.n, 0);
console.log(`Arquivos do Bradesco: ${imports.length} (${ids.map((i) => "#" + i).join(", ")}), ${total} lançamento(s).`);

const wrong = await db.query(
  `SELECT t.id, t.account FROM transactions t
   WHERE t.external_id IS NOT NULL AND t.import_id IS NOT NULL AND NOT (t.import_id = ANY($1))`, [ids]);
console.log(`Lançamentos de outros bancos ligados por engano a transações do Pluggy: ${wrong.length}.`);

if (!apply) { console.log("\n(simulação - nada foi alterado; rode com --apply para executar)"); process.exit(0); }

const [del, unlink, delImports] = await db.batch([
  { sql: "DELETE FROM transactions WHERE import_id = ANY($1) RETURNING id", params: [ids] },
  { sql: "UPDATE transactions SET external_id = NULL WHERE id = ANY($1) RETURNING id", params: [wrong.map((w) => w.id)] },
  { sql: "DELETE FROM imports WHERE id = ANY($1) RETURNING id", params: [ids] },
]);
console.log(`\nApagados: ${del.length} lançamento(s) e ${delImports.length} registro(s) de arquivo.`);
console.log(`Ligações desfeitas: ${unlink.length}.`);
