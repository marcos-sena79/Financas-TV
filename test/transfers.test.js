// Regras de transferência entre contas próprias (nomes e valores fictícios).
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { mentionsHolder, markOwnTransfers, classifyTransfers } from "../src/transfers.js";

test("reconhece o nome do titular, inclusive cortado pelo banco", () => {
  const h = "JOAO PEDRO SILVA SOUZA";
  assert.equal(mentionsHolder("Pix recebido de JOAO PEDRO SILVA SOUZA", h), true);
  assert.equal(mentionsHolder("PIX ENVIADO - DES João Pedro S 02/11", h), true);   // acento e corte
  assert.equal(mentionsHolder("PIX ENVIADO - DES Maria Silva Souza", h), false);   // parente: outra pessoa
  assert.equal(mentionsHolder("Transferência enviada pelo Pix JOAO", h), false);   // só o primeiro nome
  assert.equal(mentionsHolder("qualquer coisa", "JOAO"), false);                   // titular sem sobrenome
});

async function seed(rows, holder) {
  const db = await openDb({ url: "", dataDir: null });
  if (holder) await db.query("INSERT INTO settings (key, value) VALUES ('titular', $1)", [holder]);
  await db.batch(rows.map(([date, description, cents, direction, account, source = "extrato"]) => ({
    sql: `INSERT INTO transactions (date, description, amount_cents, direction, category, account, source)
          VALUES ($1,$2,$3,$4,'Outros',$5,$6)`,
    params: [date, description, cents, direction, account, source],
  })));
  return db;
}
const flags = async (db) => Object.fromEntries(
  (await db.query("SELECT description, is_transfer FROM transactions ORDER BY id")).map((r) => [r.description, r.is_transfer]));

test("titular, par entre bancos e entradas que não são renda", async () => {
  const db = await seed([
    ["2026-10-02", "PIX ENVIADO - DES JOAO PEDRO SILVA 02/10", 300000, "saida", "Banco Bradesco"],
    ["2026-10-02", "Pix recebido de JOAO PEDRO SILVA SOUZA", 300000, "entrada", "Nubank"],
    ["2026-10-05", "TED ENVIADA - ACME INVESTIMENTOS", 150000, "saida", "Banco Bradesco"],       // par sem nome
    ["2026-10-06", "Transferência recebida pelo Pix ACME", 150000, "entrada", "Nubank"],
    ["2026-10-07", "Transferência enviada pelo Pix Padaria Boa", 5000, "saida", "Nubank"],      // mesmo banco:
    ["2026-10-07", "Transferência recebida pelo Pix Maria Lima", 5000, "entrada", "Nu Financeira S.A."], // não é par
    ["2026-10-08", "PIX RECEBIDO - REM Maria Silva Souza", 80000, "entrada", "Banco Bradesco"], // parente: renda
    ["2026-10-09", "Resgate RDB", 50000, "entrada", "Nubank"],
    ["2026-10-10", "EMPRESTIMO PESSOAL - DOCTO 123", 370000, "entrada", "Banco Bradesco"],
    ["2026-10-11", "Valor adicionado na conta por cartão de crédito", 20000, "entrada", "Nubank"],
    ["2026-10-12", "TRANSF SALDO C/SAL P/CC - ACME SA", 800000, "entrada", "Banco Bradesco"],   // salário fica
  ], "JOAO PEDRO SILVA SOUZA");

  const r = await markOwnTransfers(db);
  assert.deepEqual(r, { titular: 2, pares: 2, naoRenda: 3 });
  const f = await flags(db);
  assert.equal(f["PIX ENVIADO - DES JOAO PEDRO SILVA 02/10"], 1);
  assert.equal(f["Pix recebido de JOAO PEDRO SILVA SOUZA"], 1);
  assert.equal(f["TED ENVIADA - ACME INVESTIMENTOS"], 1);
  assert.equal(f["Transferência recebida pelo Pix ACME"], 1);
  assert.equal(f["Transferência enviada pelo Pix Padaria Boa"], 0);
  assert.equal(f["Transferência recebida pelo Pix Maria Lima"], 0);
  assert.equal(f["PIX RECEBIDO - REM Maria Silva Souza"], 0);
  assert.equal(f["Resgate RDB"], 1);
  assert.equal(f["EMPRESTIMO PESSOAL - DOCTO 123"], 1);
  assert.equal(f["Valor adicionado na conta por cartão de crédito"], 1);
  assert.equal(f["TRANSF SALDO C/SAL P/CC - ACME SA"], 0);

  // Rodar de novo não muda nada.
  assert.deepEqual(await classifyTransfers(db), { faturas: 0, titular: 0, pares: 0, naoRenda: 0 });
  await db.close();
});

test("marcar/desmarcar à mão pelo app vale mais que as regras", async (t) => {
  const { createApp } = await import("../src/app.js");
  const db = await seed([
    ["2026-10-09", "Resgate RDB", 50000, "entrada", "Nubank"],                       // regra diria: transferência
    ["2026-10-10", "Pix enviado para MERCADO PAGO", 40000, "saida", "Nubank"],       // regra não pega
  ]);
  const app = createApp({ getDb: async () => db, extract: async () => ({}), password: "" });
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://localhost:${server.address().port}`;
  const patch = (id, body) => fetch(`${base}/api/transactions/${id}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }).then((r) => r.json());

  const [resgate, mp] = await db.query("SELECT id FROM transactions ORDER BY id");
  // Você diz: o resgate É renda (desmarca) e o Pix pro Mercado Pago é transferência (marca).
  const a = await patch(resgate.id, { is_transfer: false });
  assert.deepEqual([a.is_transfer, a.transfer_locked, a.category], [0, 1, "Outros"]);
  await db.query("UPDATE transactions SET category = 'Compras' WHERE id = $1", [mp.id]);
  const b = await patch(mp.id, { is_transfer: true });
  assert.deepEqual([b.is_transfer, b.transfer_locked, b.category], [1, 1, "Compras"], "marcar mantém a categoria");

  // As regras rodam (ex.: na sincronização diária) e não desfazem suas escolhas.
  await classifyTransfers(db);
  const f = await flags(db);
  assert.equal(f["Resgate RDB"], 0);
  assert.equal(f["Pix enviado para MERCADO PAGO"], 1);

  // Desmarcar volta exatamente ao que era.
  const c = await patch(mp.id, { is_transfer: false });
  assert.deepEqual([c.is_transfer, c.category], [0, "Compras"]);
  const s0 = await fetch(`${base}/api/summary?month=2026-10`).then((r) => r.json());
  assert.equal(s0.byCategory.find((x) => x.category === "Compras")?.total, 40000);
  const s = await fetch(`${base}/api/summary?month=2026-10`).then((r) => r.json());
  assert.equal(s.income, 50000);
  assert.equal(s.expense, 40000);
});

test("outra ponta de Pix com seu nome, empréstimo e Pix no crédito", async () => {
  const db = await seed([
    ["2026-10-16", "Transferência recebida pelo Pix JOAO PEDRO SILVA SOUZA", 1552000, "entrada", "Nubank"],
    ["2026-10-16", "PIX ENVIADO MARIA LIMA COM SALDO", 1552000, "saida", "PicPay Instituição de Pagamento"], // outra ponta
    ["2026-10-14", "PIX ENVIADO - DES JOAO PEDRO SILVA 14/10", 490000, "saida", "Banco Bradesco"],
    ["2026-10-14", "PIX recebido", 490000, "entrada", "PicPay Instituição de Pagamento"],              // outra ponta
    ["2026-10-14", "PIX recebido", 7000, "entrada", "PicPay Instituição de Pagamento"],                // sem par: renda
    ["2026-10-16", "Desembolso Refin CTPS", 1550000, "entrada", "PicPay Instituição de Pagamento"],
    ["2026-10-07", "Valor adicionado na conta via Pix no Crédito", 160000, "entrada", "Nubank"],
    ["2026-10-07", "Pix enviado para Ana Costa", 160000, "saida", "Nubank"],
    ["2026-10-08", "Pix enviado para Ana Costa", 160000, "saida", "Nubank"],                           // outro dia: gasto
  ], "JOAO PEDRO SILVA SOUZA");
  await classifyTransfers(db);
  const rows = await db.query("SELECT description, date, amount_cents, is_transfer FROM transactions ORDER BY id");
  assert.deepEqual(rows.map((r) => r.is_transfer), [1, 1, 1, 1, 0, 1, 1, 1, 0]);
  assert.deepEqual(await classifyTransfers(db), { faturas: 0, titular: 0, pares: 0, naoRenda: 0 });
  await db.close();
});

test("sem titular conhecido, a regra do nome não age", async () => {
  const db = await seed([["2026-10-02", "Pix recebido de JOAO PEDRO SILVA SOUZA", 300000, "entrada", "Nubank"]]);
  assert.deepEqual(await markOwnTransfers(db), { titular: 0, pares: 0, naoRenda: 0 });
  await db.close();
});

test("TV: últimos 10 dias, ancorados no lançamento mais recente", async () => {
  const { monthSummary } = await import("../src/summary.js");
  const db = await seed([
    ["2026-10-20", "Antes da janela de outubro", 1000, "saida", "Nubank"],
    ["2026-10-22", "Início da janela de outubro", 1000, "saida", "Nubank"],
    ["2026-10-31", "Fim de outubro", 1000, "saida", "Nubank"],
    ["2026-11-01", "Primeiro de novembro", 2000, "saida", "Nubank"],
    ["2026-11-10", "Mais recente", 3000, "entrada", "Nubank"],
    ["2026-11-13", "Depois de hoje", 4000, "saida", "Nubank"],
  ]);
  await db.query("INSERT INTO transactions (date, description, amount_cents, direction, source, is_transfer) VALUES ('2026-11-11', 'Transferência', 500, 'saida', 'extrato', 1)");

  // Hoje = 12/11, mas o banco só mandou até o dia 10: a janela é 01/11 a 10/11.
  const nov = await monthSummary(db, "2026-11", { today: "2026-11-12" });
  assert.deepEqual(nov.recentRange, { from: "2026-11-01", to: "2026-11-10", days: 10 });
  assert.deepEqual(nov.recent.map((r) => r.description), ["Mais recente", "Primeiro de novembro"]);

  // Mês passado: termina no último lançamento do mês e atravessa para o mês anterior se preciso.
  const oct = await monthSummary(db, "2026-10", { today: "2026-11-12" });
  assert.deepEqual(oct.recentRange, { from: "2026-10-22", to: "2026-10-31", days: 10 });
  assert.deepEqual(oct.recent.map((r) => r.description), ["Fim de outubro", "Início da janela de outubro"]);

  // Sem nada no banco.
  const empty = await monthSummary(db, "2020-01", { today: "2026-11-12" });
  assert.deepEqual([empty.recent, empty.recentRange.from], [[], null]);
  await db.close();
});

test("TV: mês atual traz comparativos de dias e semanas; mês passado não", async () => {
  const { monthSummary } = await import("../src/summary.js");
  // Hoje = quinta, 12/11/2026. Semana atual: seg 09/11 a dom 15/11.
  const db = await seed([
    ["2026-08-20", "Gasto antigo (média)", 90000, "saida", "Nubank"],   // entra na média dos 90 dias
    ["2026-11-02", "Seg semana passada", 1000, "saida", "Nubank"],
    ["2026-11-05", "Qui semana passada", 2000, "saida", "Nubank"],
    ["2026-11-06", "Sex semana passada (fora do até-o-dia)", 4000, "saida", "Nubank"],
    ["2026-11-09", "Seg", 500, "saida", "Nubank"],
    ["2026-11-11", "Ontem", 700, "saida", "Nubank"],
    ["2026-11-12", "Hoje", 300, "saida", "Nubank"],
    ["2026-11-12", "Salário", 900000, "entrada", "Nubank"],           // entrada não é gasto
  ]);
  const s = await monthSummary(db, "2026-11", { today: "2026-11-12" });
  const c = s.current;
  assert.equal(c.days.length, 12);
  assert.deepEqual([c.todayTotal, c.yesterday, c.sameDayLastWeek], [300, 700, 2000]);
  assert.equal(c.avgDaily, 1000);                                         // 90000 / 90 dias
  assert.equal(c.weeks.length, 8);
  assert.deepEqual(c.weeks.at(-1), { start: "2026-11-09", end: "2026-11-15", total: 1500, current: true });
  assert.equal(c.weeks.at(-2).total, 7000);
  assert.deepEqual(c.weekToDate, { current: 1500, previous: 3000, days: 4 }); // seg..qui x seg..qui
  assert.equal((await monthSummary(db, "2026-10", { today: "2026-11-12" })).current, null);
  await db.close();
});

test("lista com filtros: período, categoria e banco", async (t) => {
  const { createApp } = await import("../src/app.js");
  const db = await seed([
    ["2026-10-30", "Mercado A", 1000, "saida", "Nu Pagamentos S.A. - Instituição de Pagamento"],
    ["2026-11-02", "Mercado B", 2000, "saida", "Banco Bradesco"],
    ["2026-11-03", "Cinema", 3000, "saida", "VISA GOLD"],
    ["2026-11-04", "Café", 400, "saida", "PICPAY INSTITUIÇÃO DE PAGAMENTO S.A"],
  ]);
  await db.query("UPDATE transactions SET category = 'Mercado' WHERE description LIKE 'Mercado%'");
  await db.query("INSERT INTO transactions (date, description, amount_cents, direction, source) VALUES ('2026-11-05', 'Feira', 500, 'saida', 'manual')");
  // O cartão "VISA GOLD" é do Bradesco: a sincronização guarda isso a partir da conexão.
  const { rememberAccountBanks } = await import("../src/banks.js");
  await rememberAccountBanks(db, [{ name: "Banco Bradesco" }, { name: "VISA GOLD" }]);

  const app = createApp({ getDb: async () => db, extract: async () => ({}), password: "" });
  const server = app.listen(0);
  t.after(() => server.close());
  const get = (q) => fetch(`http://localhost:${server.address().port}/api/${q}`).then((r) => r.json()).then((b) => { if (b.error) throw new Error(q + ": " + b.error); return b; });
  const names = (rows) => rows.map((r) => r.description).sort();

  assert.deepEqual(names(await get("transactions?month=2026-11")), ["Café", "Cinema", "Feira", "Mercado B"]);
  assert.deepEqual(names(await get("transactions?from=2026-10-30&to=2026-11-02")), ["Mercado A", "Mercado B"]);
  assert.deepEqual(names(await get("transactions?from=2026-10-01&to=2026-11-30&category=Mercado")), ["Mercado A", "Mercado B"]);
  assert.deepEqual(names(await get("transactions?from=2026-10-01&to=2026-11-30&bank=Bradesco")), ["Cinema", "Mercado B"]);
  assert.deepEqual(names(await get("transactions?from=2026-10-01&to=2026-11-30&bank=Nubank&category=Mercado")), ["Mercado A"]);
  assert.deepEqual((await get("filters")).banks, ["Bradesco", "Lançado à mão", "Nubank", "PicPay"]);
});
