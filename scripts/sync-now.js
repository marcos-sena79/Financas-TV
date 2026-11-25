// Sincroniza o Open Finance agora, direto no banco indicado por DATABASE_URL.
// Uso: node --env-file=.env --env-file=<arquivo com DATABASE_URL> scripts/sync-now.js [dias]
//      [dias] = quantos dias para trás buscar (padrão: PLUGGY_DAYS ou 60)
import { openDb } from "../src/db.js";
import { syncPluggy } from "../src/pluggy.js";
import { monthSummary } from "../src/summary.js";

const db = await openDb();
const days = process.argv[2] ? Number(process.argv[2]) : undefined;
const r = await syncPluggy(db, { days });
console.log(`Sincronizado: ${r.novo} novo(s), ${r.conciliar} conciliado(s), ${r.ignorado} já existente(s), ${r.pendentes} pendente(s).`);
console.log(`Contas: ${r.contas.join(", ")}`);
if (r.avisos.length) console.log("Avisos:", r.avisos.join(" | "));
const [tit] = await db.query("SELECT value FROM settings WHERE key = 'titular'");
console.log(`Titular conhecido: ${tit ? "sim" : "não (a Pluggy não informou; defina TITULAR)"}`);
console.log("Marcados como transferência:", JSON.stringify(r.transferencias));

const rows = await db.query(
  `SELECT substr(date,1,7) AS mes, source, COUNT(*)::int AS n FROM transactions
   WHERE external_id IS NOT NULL GROUP BY 1, 2 ORDER BY 1, 2`);
for (const x of rows) console.log(`  ${x.mes}  ${x.source.padEnd(8)} ${x.n} lançamento(s)`);
const s = await monthSummary(db, new Date().toISOString().slice(0, 7));
const brl = (c) => (c / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
console.log(`Mês atual: receitas ${brl(s.income)}, despesas ${brl(s.expense)}, ${s.byCategory.length} categorias de gasto.`);
