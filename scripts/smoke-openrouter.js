// Teste real contra a OpenRouter com um extrato FICTÍCIO (nenhum dado seu é enviado).
// Uso: node --env-file=.env scripts/smoke-openrouter.js
import { extractDocument } from "../src/extractor.js";

const csv = `Data;Descrição;Valor;Saldo
01/11/2026;SALDO ANTERIOR;;1.000,00
05/11/2026;TED RECEBIDA ACME LTDA SALARIO;6.149,60;7.149,60
06/11/2026;PAG FATURA NUBANK;-1.500,00;5.649,60
07/11/2026;PIX ENVIADO IMOBILIARIA SOL;-2.200,00;3.449,60
09/11/2026;COMPRA DEBITO SUPERMERCADO DIA;-312,45;3.137,15
10/11/2026;PIX ENVIADO MARIA SILVA;-80,00;3.057,15`;

const t0 = Date.now();
try {
  const out = await extractDocument(Buffer.from(csv, "utf8"), "text/csv", "extrato-teste.csv");
  console.log(`OK em ${((Date.now() - t0) / 1000).toFixed(1)}s - tipo: ${out.document_type}, banco: ${out.institution}`);
  for (const t of out.transactions) {
    console.log(`  ${t.date}  ${t.direction.padEnd(7)} ${t.amount.toFixed(2).padStart(9)}  ${t.category.padEnd(18)} ${t.is_transfer ? "[transf] " : ""}${t.description}`);
  }
  if (out.warnings.length) console.log("  avisos:", out.warnings.join(" | "));
} catch (e) {
  console.error(`FALHOU em ${((Date.now() - t0) / 1000).toFixed(1)}s: ${e.message}`);
  process.exit(1);
}
