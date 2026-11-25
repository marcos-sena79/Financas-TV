import { reconcile as reconcileForPairs } from "../src/reconcile.js";
// Testa o fluxo completo sem chamar a API real: o leitor de IA é substituído por respostas fixas.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { createApp } from "../src/app.js";

const fatura = {
  document_type: "fatura", institution: "Nubank", period_start: "2026-10-05", period_end: "2026-11-04",
  payslip: null, warnings: [],
  transactions: [
    { date: "2026-10-12", description: "Padaria Pão Quente", raw_description: "PAO QUENTE PADARIA", amount: 23.5, direction: "saida", category: "Alimentação", is_transfer: false, installment: null },
    { date: "2026-10-15", description: "Magazine Luiza", raw_description: "MAGALU*LOJA 03/10", amount: 199.9, direction: "saida", category: "Compras", is_transfer: false, installment: "03/10" },
    { date: "2026-10-20", description: "Pagamento recebido", raw_description: "PAGAMENTO RECEBIDO", amount: 1500, direction: "entrada", category: "Transferência", is_transfer: true, installment: null },
  ],
};
const holerite = {
  document_type: "holerite", institution: "ACME Ltda", period_start: "2026-10-01", period_end: "2026-10-31",
  payslip: { employer: "ACME Ltda", reference_month: "2026-10", payment_date: "2026-11-05", gross: 8000, total_deductions: 1850.4, net: 6149.6 },
  warnings: [],
  transactions: [{ date: "2026-11-05", description: "Salário ACME", raw_description: "SALARIO", amount: 6149.6, direction: "entrada", category: "Salário", is_transfer: false, installment: null }],
};
const extrato = {
  document_type: "extrato", institution: "Itaú", period_start: "2026-11-01", period_end: "2026-11-10",
  payslip: null, warnings: [],
  transactions: [
    { date: "2026-11-05", description: "Salário", raw_description: "TED REMUNERACAO ACME", amount: 6149.6, direction: "entrada", category: "Salário", is_transfer: false, installment: null },
    { date: "2026-11-06", description: "Pagamento fatura Nubank", raw_description: "PAG FATURA NU", amount: 1500, direction: "saida", category: "Transferência", is_transfer: true, installment: null },
    { date: "2026-11-07", description: "Aluguel", raw_description: "PIX ENVIADO IMOBILIARIA", amount: 2200, direction: "saida", category: "Moradia", is_transfer: false, installment: null },
  ],
};

const byName = { "fatura.pdf": fatura, "holerite.pdf": holerite, "extrato.pdf": extrato };

async function start({ password = "" } = {}) {
  const app = createApp({
    getDb: () => openDb({ url: "", dataDir: null }), // Postgres em memória
    extract: async (_buf, _mime, name) => structuredClone(byName[name]),
    password,
  });
  const server = app.listen(0);
  const base = `http://localhost:${server.address().port}`;
  let cookie = "";
  const json = async (path, opts = {}) => {
    const r = await fetch(base + path, { ...opts, headers: { ...(opts.headers || {}), cookie } });
    const set = r.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    return { status: r.status, body: await r.json() };
  };
  const upload = (name, content = name) => {
    const fd = new FormData();
    fd.append("file", new Blob([content], { type: "application/pdf" }), name);
    return json("/api/upload", { method: "POST", body: fd });
  };
  const commit = (token, items = []) => json(`/api/upload/${token}/commit`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items }),
  });
  return { server, json, upload, commit };
}

test("lançamento manual é conciliado com a fatura, sem duplicar", async (t) => {
  const { server, json, upload, commit } = await start();
  t.after(() => server.close());

  // Usuário anotou a padaria no dia 11 (a fatura diz dia 12).
  const m = await json("/api/transactions", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ date: "2026-10-11", description: "Padaria", amount: 23.5, direction: "saida", category: "Alimentação" }),
  });
  assert.equal(m.status, 201);

  const up = await upload("fatura.pdf");
  assert.equal(up.status, 200);
  assert.deepEqual(up.body.items.map((i) => i.action), ["conciliar", "novo", "novo"]);
  assert.equal(up.body.items[0].match.description, "Padaria");

  const c = await commit(up.body.token);
  assert.deepEqual(c.body, { novo: 2, conciliar: 1, ignorado: 0 });

  const oct = (await json("/api/transactions?month=2026-10")).body;
  assert.equal(oct.length, 3);
  const padaria = oct.find((x) => x.description === "Padaria");
  assert.equal(padaria.reconciled, 1);
  assert.equal(padaria.date, "2026-10-12");

  // Pagamento da fatura não entra como receita.
  const s = (await json("/api/summary?month=2026-10")).body;
  assert.equal(s.income, 0);
  assert.equal(s.expense, 2350 + 19990);

  // Mesmo arquivo de novo é recusado.
  const again = await upload("fatura.pdf");
  assert.equal(again.status, 400);
  assert.match(again.body.error, /já foi importado/);
});

test("salário do holerite não duplica quando o extrato chega", async (t) => {
  const { server, json, upload, commit } = await start();
  t.after(() => server.close());

  const h = await upload("holerite.pdf");
  assert.equal(h.body.payslip.net, 6149.6);
  await commit(h.body.token);

  const e = await upload("extrato.pdf");
  assert.deepEqual(e.body.items.map((i) => i.action), ["duplicado", "novo", "novo"]);
  // A tela já vem com "duplicado" marcado como ignorar; aqui mandamos explicitamente.
  const c = await commit(e.body.token, [{ index: 0, action: "ignorar" }]);
  assert.deepEqual(c.body, { novo: 2, conciliar: 0, ignorado: 1 });

  const s = (await json("/api/summary?month=2026-11")).body;
  assert.equal(s.income, 614960);
  assert.equal(s.salary, 614960);
  assert.equal(s.expense, 220000); // aluguel; pagamento de fatura é transferência
  assert.equal(s.balance, 614960 - 220000);
  assert.equal(s.byCategory[0].category, "Moradia");

  // Confirmar a mesma prévia duas vezes não duplica nada.
  const again = await commit(e.body.token);
  assert.equal(again.status, 400);
});

// ---- Leitor via OpenRouter, com a API simulada
const fakeFetch = (status, payload, capture = {}) => async (url, init) => {
  capture.url = url;
  capture.body = JSON.parse(init.body);
  capture.headers = init.headers;
  return new Response(JSON.stringify(payload), { status });
};
const okReply = (content, model = "nvidia/nemotron-3.5-super-vl:free") =>
  ({ model, choices: [{ finish_reason: "stop", message: { content } }] });

test("OpenRouter: PDF vai com leitor gratuito e só modelos :free", async () => {
  process.env.OPENROUTER_API_KEY = "sk-or-teste";
  const { extractDocument } = await import("../src/extractor.js");
  const cap = {};
  // Resposta "suja": JSON entre crases, valor como texto em formato brasileiro, categoria inventada.
  const content = "```json\n" + JSON.stringify({
    document_type: "holerite", institution: "ACME", period_start: null, period_end: null,
    payslip: { employer: "ACME", reference_month: "2026-10", payment_date: "2026-11-05", gross: "8.000,00", total_deductions: 1850.4, net: "6.149,60" },
    transactions: [{ date: "2026-11-05", description: "Salário", amount: "6.149,60", direction: "entrada", category: "Remuneração", is_transfer: false }],
  }) + "\n```";
  const out = await extractDocument(Buffer.from("%PDF-1.4 x"), "application/pdf", "holerite.pdf",
    { fetchImpl: fakeFetch(200, okReply(content), cap) });

  assert.equal(cap.url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(cap.headers.Authorization, "Bearer sk-or-teste");
  assert.ok(cap.body.models.length > 0 && cap.body.models.every((m) => m.endsWith(":free")));
  assert.deepEqual(cap.body.plugins, [{ id: "file-parser", pdf: { engine: "cloudflare-ai" } }]);
  assert.equal(cap.body.messages[1].content[1].type, "file");
  assert.equal(cap.body.response_format.type, "json_schema");

  assert.equal(out.payslip.net, 6149.6);
  assert.equal(out.payslip.gross, 8000);
  assert.equal(out.transactions[0].amount, 6149.6);
  assert.equal(out.transactions[0].category, "Outros");
  assert.equal(out.transactions[0].installment, null);
});

test("OpenRouter: foto vai como imagem, sem leitor de PDF", async () => {
  process.env.OPENROUTER_API_KEY = "sk-or-teste";
  const { extractDocument } = await import("../src/extractor.js");
  const cap = {};
  const content = JSON.stringify({ document_type: "fatura", institution: null, period_start: null, period_end: null,
    payslip: null, transactions: [], warnings: [] });
  await extractDocument(Buffer.from([1, 2, 3]), "image/jpeg", "fatura.jpg", { fetchImpl: fakeFetch(200, okReply(content), cap) });
  assert.equal(cap.body.messages[1].content[1].type, "image_url");
  assert.match(cap.body.messages[1].content[1].image_url.url, /^data:image\/jpeg;base64,/);
  assert.equal(cap.body.plugins, undefined);
});

test("OpenRouter: erros viram mensagens claras", async () => {
  process.env.OPENROUTER_API_KEY = "sk-or-teste";
  const { extractDocument, AIError } = await import("../src/extractor.js");
  const run = (status, payload) => extractDocument(Buffer.from("a;b"), "text/csv", "x.csv", { fetchImpl: fakeFetch(status, payload) });

  await assert.rejects(run(429, { error: { code: 429, message: "Rate limit exceeded" } }), /50 por dia/);
  await assert.rejects(run(401, { error: { code: 401, message: "No auth" } }), /Chave da OpenRouter inválida/);
  await assert.rejects(run(402, { error: { code: 402, message: "neg" } }), /saldo negativo/);
  await assert.rejects(run(404, { error: { code: 404, message: "No endpoints found" } }), /OPENROUTER_MODELS/);
  await assert.rejects(run(200, okReply("desculpe, não consigo")), AIError);

  delete process.env.OPENROUTER_API_KEY;
  await assert.rejects(run(200, okReply("{}")), /OPENROUTER_API_KEY/);
});

test("com senha, a API exige login", async (t) => {
  const { server, json } = await start({ password: "segredo123" });
  t.after(() => server.close());

  assert.equal((await json("/api/summary")).status, 401);
  const bad = await json("/api/login", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "errada" }),
  });
  assert.equal(bad.status, 401);
  const ok = await json("/api/login", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "segredo123" }),
  });
  assert.equal(ok.status, 200);
  assert.equal((await json("/api/summary")).status, 200);
});

test("conciliação escolhe o par certo quando o mesmo valor aparece em dias próximos", async () => {
  const { openDb } = await import("../src/db.js");
  const db = await openDb({ url: "", dataDir: null });
  await db.query(`INSERT INTO transactions (date, description, amount_cents, direction, source, account) VALUES
    ('2026-09-30', 'Transferência enviada pelo Pix Fulano Tal', 3000, 'saida', 'extrato', 'Nubank')`);
  // O Pix do Ciclano (dia 03) não está no PDF: é novo, e não pode "roubar" o par do Fulano.
  // Chegam na ordem "errada": o do dia 03 antes do dia 30.
  const items = await reconcileForPairs(db, [
    { date: "2026-10-03", description: "Transferência enviada pelo Pix|Ciclano Beltrano", amount: 30, direction: "saida" },
    { date: "2026-09-30", description: "Transferência enviada pelo Pix|Fulano Tal", amount: 30, direction: "saida" },
  ]);
  assert.deepEqual(items.map((i) => [i.action, i.match?.date]), [["novo", undefined], ["duplicado", "2026-09-30"]]);
  await db.close();
});
