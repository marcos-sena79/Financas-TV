// Correção pontual: marca como transferência os pagamentos de fatura que já entraram pelo Open Finance
// como gasto (texto "GASTOS CARTAO DE CREDITO" do Bradesco, não reconhecido pela regra antiga).
// Uso: node --env-file=<arquivo com DATABASE_URL> scripts/fix-bill-payments.js
import { openDb } from "../src/db.js";

const db = await openDb();
const rows = await db.query(
  `UPDATE transactions SET is_transfer = 1, category = 'Transferência'
   WHERE external_id IS NOT NULL AND source = 'extrato' AND direction = 'saida' AND is_transfer = 0
     AND (description ~* 'gastos?\\s+(c/)?cart[aã]o' OR description ~* 'cart[aã]o\\s+de\\s+cr[eé]dito')
   RETURNING date, amount_cents, description`);
for (const r of rows) console.log(`  corrigido: ${r.date}  R$ ${(r.amount_cents / 100).toFixed(2)}  ${r.description}`);
console.log(`${rows.length} lançamento(s) marcado(s) como pagamento de fatura.`);
