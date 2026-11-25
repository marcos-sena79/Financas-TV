// Open Finance (Meu Pluggy) com a API da Pluggy simulada.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { createApp } from "../src/app.js";
import { mapTransaction, toLocalDate, connectMeuPluggy, bankTokens, sameBank, markCardPayments } from "../src/pluggy.js";

test("pagamento de fatura por Pix QR é reconhecido pelo par com o cartão", async () => {
  const db = await openDb({ url: "", dataDir: null });
  const ins = (date, desc, cents, dir, source, transfer) => ({
    sql: `INSERT INTO transactions (date, description, amount_cents, direction, category, source, is_transfer)
          VALUES ($1,$2,$3,$4,'Outros',$5,$6)`, params: [date, desc, cents, dir, source, transfer],
  });
  await db.batch([
    ins("2026-10-30", "PAGTO ANTECIPADO PIX", 206908, "entrada", "fatura", 1),              // no cartão
    ins("2026-10-30", "PIX QR CODE DINAMICO - DES RECEBTO PAGTO ANTEC G", 206908, "saida", "extrato", 0), // na conta
    ins("2026-10-31", "Mercado", 206908, "saida", "extrato", 0),   // mesmo valor, mas só um débito por pagamento
    ins("2026-10-15", "Aluguel", 220000, "saida", "extrato", 0),   // sem par no cartão
  ]);
  assert.equal(await markCardPayments(db), 1);
  const rows = await db.query("SELECT description, is_transfer FROM transactions WHERE source='extrato' ORDER BY id");
  assert.deepEqual(rows.map((r) => r.is_transfer), [1, 0, 0]);
  assert.equal(await markCardPayments(db), 0, "rodar de novo não marca mais nada");
  await db.close();
});

test("salário vindo da conta-salário é Salário", () => {
  const t = { id: "s", date: day("2026-11-05"), description: "TRANSF SALDO C/SAL P/CC - CIELO S.A - INSTITUICAO DE PAG", amount: 7995.5, type: "CREDIT", status: "POSTED" };
  const m = mapTransaction(t, { type: "BANK", name: "Banco Bradesco" });
  assert.equal(m.category, "Salário");
  assert.equal(m.is_transfer, false);
  assert.equal(m.direction, "entrada");
});

test("comparação só entre lançamentos do mesmo banco", () => {
  assert.equal(sameBank("VISA GOLD", bankTokens(["Banco Bradesco", "VISA GOLD"])), true, "cartão sem nome de banco");
  const banks = bankTokens(["Banco Bradesco", "VISA GOLD", "MeuPluggy"]);
  assert.deepEqual([...banks], ["bradesco"]);
  assert.equal(sameBank("Bradesco", banks), true);          // fatura Bradesco em PDF
  assert.equal(sameBank("Banco Bradesco S.A.", banks), true);
  assert.equal(sameBank("Nubank", banks), false);           // extrato Nubank em PDF
  assert.equal(sameBank("Nu Financeira S.A.", banks), false);
  assert.equal(sameBank(null, banks), true);                // lançamento manual
  assert.equal(sameBank("Nubank", new Set()), true);        // banco da conexão desconhecido
});

test("conectar: cria item MeuPluggy, entrega o link e devolve o id quando autorizado", async () => {
  const seen = { posts: [], polls: 0 };
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s });
    if (u.pathname === "/auth") return json({ apiKey: "k" });
    if (u.pathname === "/connectors/200") return json({ id: 200, name: "MeuPluggy", oauth: true });
    if (u.pathname === "/items" && init.method === "POST") {
      seen.posts.push(JSON.parse(init.body));
      return json({ id: "new-item", status: "UPDATING" });
    }
    if (u.pathname === "/items/new-item") {
      seen.polls++;
      if (seen.polls === 1) return json({ id: "new-item", status: "UPDATING" }); // link ainda não pronto
      if (seen.polls <= 3) {
        return json({ id: "new-item", status: "WAITING_USER_INPUT",
          parameter: { type: "oauth", name: "oauthCode", data: "https://meu.pluggy.ai/oauth?state=x" } });
      }
      return json({ id: "new-item", status: "UPDATED", executionStatus: "SUCCESS" });
    }
    if (u.pathname === "/accounts") return json({ results: [{ name: "Conta Nubank" }, { name: "Cartão", marketingName: "Nubank Ultravioleta" }] });
    return json({ message: "?" }, 404);
  };
  const urls = [];
  const res = await connectMeuPluggy({
    fetchImpl, env: { PLUGGY_CLIENT_ID: "a", PLUGGY_CLIENT_SECRET: "b" },
    onUrl: (u) => urls.push(u), sleep: async () => {},
  });
  assert.deepEqual(seen.posts, [{ connectorId: 200, parameters: {},
    oauthRedirectUri: "https://financas-tv.vercel.app/pluggy-ok.html" }]);
  assert.deepEqual(urls, ["https://meu.pluggy.ai/oauth?state=x"], "link mostrado uma única vez");
  assert.deepEqual(res, { id: "new-item", contas: ["Conta Nubank", "Nubank Ultravioleta"] });
});

test("conectar: sem credenciais, pede para configurar o .env", async () => {
  await assert.rejects(connectMeuPluggy({ env: {}, onUrl: () => {} }), /PLUGGY_CLIENT_ID/);
});

const env = { PLUGGY_CLIENT_ID: "cid", PLUGGY_CLIENT_SECRET: "sec", PLUGGY_ITEM_IDS: "item-1", PLUGGY_DAYS: "3650" };
const day = (d) => `${d}T00:00:00.000Z`;

const cardTx = [
  { id: "c1", date: day("2026-11-12"), description: "Padaria Pao Quente", descriptionRaw: "PAO QUENTE", amount: 23.5, type: "DEBIT", status: "POSTED", category: "Food and drinks" },
  { id: "c2", date: day("2026-11-13"), description: "Pagamento recebido", amount: -1500, type: "CREDIT", status: "POSTED", operationType: "PAGAMENTO_FATURA" },
  { id: "c3", date: day("2026-11-14"), description: "Starbucks", amount: 12, type: "DEBIT", status: "POSTED", category: "Food and drinks" },
  { id: "c4", date: day("2026-11-14"), description: "Starbucks", amount: 12, type: "DEBIT", status: "POSTED", category: "Food and drinks" },
  { id: "c5", date: day("2026-11-15"), description: "Magalu", amount: 199.9, type: "DEBIT", status: "POSTED", category: "Shopping",
    creditCardMetadata: { installmentNumber: 3, totalInstallments: 10 } },
  { id: "c6", date: day("2026-11-16"), description: "Uber", amount: 30, type: "DEBIT", status: "PENDING", category: "Transportation" },
];
const bankTx = [
  { id: "b1", date: day("2026-11-05"), description: "TED Remuneracao ACME", amount: 6149.6, type: "CREDIT", status: "POSTED", category: "Salary" },
  { id: "b2", date: day("2026-11-10"), description: "Pagamento fatura cartao Nubank", amount: -1500, type: "DEBIT", status: "POSTED", category: "Credit card payment" },
];

function fakePluggy(calls = [], opts = {}) {
  // opts.prefix muda os ids das transações (como acontece ao reconectar o banco no Meu Pluggy).
  const ids = (list) => list.map((x) => ({ ...x, id: (opts.prefix || "") + x.id }));
  return async (url, init = {}) => {
    const u = new URL(url);
    calls.push(u.pathname + u.search);
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
    if (u.pathname === "/auth") {
      const b = JSON.parse(init.body);
      return b.clientId === "cid" && b.clientSecret === "sec" ? json({ apiKey: "k" }) : json({ message: "bad" }, 401);
    }
    if (init.headers?.["X-API-KEY"] !== "k") return json({ message: "no key" }, 403);
    if (u.pathname === "/items/item-1") return json({ id: "item-1", status: "UPDATED", connector: { name: "MeuPluggy" } });
    if (u.pathname === "/accounts") {
      return json({ results: [
        { id: "acc-card", type: "CREDIT", name: "Nubank Cartão", marketingName: "Nubank Ultravioleta" },
        { id: "acc-bank", type: "BANK", name: "Conta Itaú" },
      ] });
    }
    if (u.pathname === "/v2/transactions") {
      const acc = u.searchParams.get("accountId");
      if (acc === "acc-bank") return json({ results: ids(bankTx), next: null });
      // Cartão em duas páginas, para testar o cursor.
      if (!u.searchParams.get("after")) return json({ results: ids(cardTx.slice(0, 3)), next: "/v2/transactions?accountId=acc-card&after=CUR2" });
      assert.equal(u.searchParams.get("after"), "CUR2");
      return json({ results: ids(cardTx.slice(3).concat(opts.extra || [])), next: null });
    }
    return json({ message: "not found" }, 404);
  };
}

async function start(opts = {}) {
  const calls = [];
  const app = createApp({
    getDb: () => openDb({ url: "", dataDir: null }),
    extract: async () => { throw new Error("não usado"); },
    password: "",
    pluggyFetch: fakePluggy(calls, opts),
    pluggyEnv: env,
    cronSecret: "cron-123",
  });
  const server = app.listen(0);
  const base = `http://localhost:${server.address().port}`;
  const json = async (path, opts = {}) => {
    const r = await fetch(base + path, opts);
    return { status: r.status, body: await r.json() };
  };
  return { server, json, calls };
}

test("mapeamento: sinais de cartão e conta, transferências, parcela e data", () => {
  const card = { type: "CREDIT", name: "Cartão" }, bank = { type: "BANK", name: "Conta" };
  assert.deepEqual(
    (({ direction, is_transfer, category }) => ({ direction, is_transfer, category }))(mapTransaction(cardTx[1], card)),
    { direction: "entrada", is_transfer: true, category: "Transferência" });
  assert.equal(mapTransaction(cardTx[0], card).direction, "saida");
  assert.equal(mapTransaction(cardTx[0], card).category, "Alimentação");
  assert.equal(mapTransaction(cardTx[4], card).installment, "03/10");
  assert.equal(mapTransaction(cardTx[4], card).source, "fatura");
  assert.equal(mapTransaction(bankTx[0], bank).category, "Salário");
  assert.equal(mapTransaction(bankTx[1], bank).is_transfer, true);
  assert.equal(mapTransaction(bankTx[1], bank).amount, 1500);
  // Bradesco descreve o pagamento da fatura assim:
  const bradesco = { id: "x", date: day("2026-11-05"), description: "GASTOS CARTAO DE CREDITO - DOCTO: 3990308", amount: -1998.97, type: "DEBIT", status: "POSTED" };
  assert.equal(mapTransaction(bradesco, bank).is_transfer, true);
  assert.equal(mapTransaction(bradesco, bank).category, "Transferência");
  // Compra no débito não é pagamento de fatura.
  const debito = { id: "y", date: day("2026-11-05"), description: "COMPRA CARTAO DEBITO PADARIA", amount: -20, type: "DEBIT", status: "POSTED" };
  assert.equal(mapTransaction(debito, bank).is_transfer, false);
  assert.equal(toLocalDate("2026-11-05T00:00:00.000Z"), "2026-11-05");
  assert.equal(toLocalDate("2026-11-06T01:30:00.000Z"), "2026-11-05"); // 22h30 em Brasília
});

test("sincronização concilia com manual, não duplica e respeita pendentes", async (t) => {
  const { server, json, calls } = await start();
  t.after(() => server.close());

  // Gasto anotado à mão antes da fatura.
  await json("/api/transactions", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ date: "2026-11-11", description: "Padaria", amount: 23.5, direction: "saida", category: "Alimentação" }),
  });

  const first = await json("/api/sync", { method: "POST" });
  assert.equal(first.status, 200);
  assert.equal(first.body.conciliar, 1);   // padaria
  assert.equal(first.body.novo, 6);        // pag. fatura (cartão), 2 cafés, magalu, salário, pag. fatura (conta)
  assert.equal(first.body.pendentes, 1);   // uber pendente
  assert.ok(calls.some((c) => c.includes("after=CUR2")), "seguiu o cursor da paginação");

  const nov = (await json("/api/transactions?month=2026-11")).body;
  assert.equal(nov.length, 7);
  const padaria = nov.find((x) => x.description === "Padaria");
  assert.equal(padaria.reconciled, 1);
  assert.equal(padaria.external_id, "c1");
  assert.equal(nov.filter((x) => x.description === "Starbucks").length, 2, "dois cafés iguais são duas compras");

  // Sincronizar de novo não muda nada.
  const second = await json("/api/sync", { method: "POST" });
  assert.deepEqual([second.body.novo, second.body.conciliar, second.body.ignorado], [0, 0, 0]);
  assert.equal((await json("/api/transactions?month=2026-11")).body.length, 7);

  const s = (await json("/api/summary?month=2026-11")).body;
  assert.equal(s.income, 614960);                    // só o salário; pagamentos de fatura são transferências
  assert.equal(s.expense, 2350 + 1200 * 2 + 19990);
  assert.ok(s.lastSync);

  const st = (await json("/api/sync/status")).body;
  assert.equal(st.configured, true);
  assert.deepEqual(st.result.contas, ["Nubank Ultravioleta", "Conta Itaú"]);
});

test("reconectar o banco (ids novos) não duplica nada", async (t) => {
  const opts = {};
  const { server, json } = await start(opts);
  t.after(() => server.close());
  await json("/api/sync", { method: "POST" });
  const before = (await json("/api/transactions?month=2026-11")).body;

  opts.prefix = "novo-";
  const r = (await json("/api/sync", { method: "POST" })).body;
  assert.equal(r.novo, 0);
  const after = (await json("/api/transactions?month=2026-11")).body;
  assert.equal(after.length, before.length);
  assert.equal(after.filter((x) => x.description === "Starbucks").length, 2, "os dois cafés continuam sendo dois");
  assert.ok(after.every((x) => x.external_id.startsWith("novo-")), "passam a apontar para os ids novos");
  assert.deepEqual((await json("/api/sync", { method: "POST" })).body.novo, 0);
});

test("tarefa agendada exige o CRON_SECRET", async (t) => {
  const { server, json } = await start();
  t.after(() => server.close());
  assert.equal((await json("/api/cron/sync")).status, 401);
  assert.equal((await json("/api/cron/sync", { headers: { authorization: "Bearer errado" } })).status, 401);
  const ok = await json("/api/cron/sync", { headers: { authorization: "Bearer cron-123" } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.novo, 7);
});

test("categoria: editar, aplicar aos parecidos e lembrar para os próximos", async (t) => {
  const opts = {};
  const { server, json } = await start(opts);
  t.after(() => server.close());
  await json("/api/sync", { method: "POST" });
  const patch = (id, body) => json("/api/transactions/" + id, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const starbucks = () => json("/api/transactions?month=2026-11").then((r) => r.body.filter((x) => x.description === "Starbucks"));

  const [a, b] = await starbucks();
  // Só este: o outro Starbucks continua como estava, e a resposta conta quantos são parecidos.
  const one = await patch(a.id, { category: "Lazer" });
  assert.deepEqual([one.status, one.body.category, one.body.similar], [200, "Lazer", 1]);
  assert.equal((await starbucks()).find((x) => x.id === b.id).category, b.category);

  // Aplicar aos parecidos.
  const all = await patch(a.id, { category: "Lazer", apply_similar: true });
  assert.deepEqual([all.body.similar_updated, all.body.similar], [1, 0]);
  assert.ok((await starbucks()).every((x) => x.category === "Lazer"));

  // Um Starbucks novo vindo do banco já chega como Lazer.
  opts.extra = [{ id: "c7", date: day("2026-11-17"), description: "STARBUCKS ", amount: 15, type: "DEBIT", status: "POSTED", category: "Food and drinks" }];
  await json("/api/sync", { method: "POST" });
  const novo = (await json("/api/transactions?month=2026-11")).body.find((x) => x.external_id === "c7");
  assert.equal(novo.category, "Lazer");

  assert.equal((await patch(a.id, { category: "Inventada" })).status, 400);
});
