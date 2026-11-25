// Correção pontual (23/11/2026) dos dados já importados:
//  - pagamentos de fatura feitos por Pix QR / boleto passam a ser transferência (par com o cartão)
//  - "TRANSF SALDO C/SAL P/CC" (conta-salário -> corrente) passa a ser Salário
// Depois mostra receitas e despesas dos últimos meses.
// Uso: node --env-file=<arquivo com DATABASE_URL> scripts/fix-classification.js
import { openDb } from "../src/db.js";
import { markCardPayments } from "../src/pluggy.js";
import { monthSummary } from "../src/summary.js";

const db = await openDb();
console.log(`Pagamentos de fatura marcados como transferência: ${await markCardPayments(db)}`);
const sal = await db.query(
  `UPDATE transactions SET category = 'Salário'
   WHERE direction = 'entrada' AND is_transfer = 0 AND category <> 'Salário'
     AND description ~* '(c/\\s*sal\\M|conta\\s+sal)' RETURNING id`);
console.log(`Entradas da conta-salário recategorizadas como Salário: ${sal.length}`);

const brl = (c) => (c / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }).padStart(14);
const s = await monthSummary(db, new Date().toISOString().slice(0, 7));
console.log("\nMês       receitas        despesas         saldo");
for (const h of s.history) console.log(`${h.month}  ${brl(h.income)}  ${brl(h.expense)}  ${brl(h.income - h.expense)}`);
