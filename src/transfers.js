// Movimentações que NÃO são receita nem despesa: dinheiro mudando de lugar entre contas suas.
// Contá-las inflaria os dois lados (sai de um banco como "gasto" e entra no outro como "receita").
// Todas as regras só marcam como transferência (nunca apagam) e podem rodar quantas vezes quiser.
// Lançamentos que você marcou/desmarcou à mão no app (transfer_locked = 1) nunca são alterados.

const DAY = 86_400_000;
const TRANSFER_WORDS = /\b(pix|ted|doc|transf|transfer[eê]ncia)/i;

const GENERIC = new Set(["banco", "bank", "conta", "corrente", "poupanca", "cartao", "credito", "debito", "visa",
  "mastercard", "master", "elo", "amex", "gold", "platinum", "black", "infinite", "signature", "internacional",
  "nacional", "meupluggy", "pluggy", "pagamento", "pagamentos", "instituicao", "financeira", "ltda"]);

const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const words = (s) => norm(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 2 && !GENERIC.has(w) && !/^\d+$/.test(w));

/** Palavras que identificam o banco a partir de nomes de contas (ex.: "Banco Bradesco" -> "bradesco"). */
export function bankTokens(names) {
  return new Set(names.flatMap(words));
}

/** O lançamento (pelo nome da conta/instituição) é do mesmo banco? Sem informação: considera que sim. */
export function sameBank(account, banks) {
  if (!account || !banks.size) return true;
  const w = words(account);
  // Conta só com palavras genéricas ("VISA GOLD", "platinum"): não dá para saber o banco.
  if (!w.length) return true;
  return w.some((x) => banks.has(x)) || [...banks].some((b) => w.some((x) => x.startsWith(b) || b.startsWith(x)));
}

/**
 * O texto cita o titular? Exige o primeiro nome e mais um dos outros nomes inteiro
 * (bancos cortam nomes longos: "FULANO DE TAL S" ainda bate pelo "tal").
 */
export function mentionsHolder(text, holder) {
  const names = norm(holder).split(/\s+/).filter((w) => w.length >= 2 && !["de", "da", "do", "dos", "das", "e"].includes(w));
  if (names.length < 2) return false;
  const t = ` ${norm(text).replace(/[^a-z0-9]+/g, " ")} `;
  const [first, ...rest] = names;
  return t.includes(` ${first} `) && rest.some((n) => t.includes(` ${n} `));
}

// Entradas que não são renda: resgate de aplicação, dinheiro de empréstimo, saldo colocado via cartão.
const NOT_INCOME = /resgate|empr[eé]stimo|financiamento|cr[eé]dito pessoal|adicionado na conta por cart[aã]o|pix no cr[eé]dito|desembolso|\brefin\b|antecipa[cç][aã]o de (fgts|saque)/i;
// "Pix no crédito": o cartão põe o valor na conta e o Pix sai em seguida. O gasto de verdade é a
// cobrança no cartão (com juros); o Pix que saiu da conta com esse dinheiro não conta de novo.
const PIX_ON_CREDIT = /pix no cr[eé]dito/i;

/**
 * Pagamento de fatura, de qualquer banco e forma (boleto, débito, Pix QR...): se o cartão registrou
 * um pagamento recebido e uma conta tem um débito de MESMO valor em até 3 dias, esse débito é o
 * pagamento da fatura. Cada pagamento do cartão marca no máximo um débito.
 */
export async function markCardPayments(db) {
  const rows = await db.query(
    `WITH pares AS (
       SELECT DISTINCT ON (c.id) c.id AS card_id, b.id AS bank_id
       FROM transactions c
       JOIN transactions b
         ON b.source = 'extrato' AND b.direction = 'saida' AND b.is_transfer = 0 AND b.transfer_locked = 0
        AND b.amount_cents = c.amount_cents AND abs(b.date::date - c.date::date) <= 3
       WHERE c.source = 'fatura' AND c.direction = 'entrada' AND c.is_transfer = 1
         AND NOT EXISTS (
           SELECT 1 FROM transactions b2
           WHERE b2.source = 'extrato' AND b2.direction = 'saida' AND b2.is_transfer = 1
             AND b2.amount_cents = c.amount_cents AND abs(b2.date::date - c.date::date) <= 3)
       ORDER BY c.id, abs(b.date::date - c.date::date), b.id
     )
     UPDATE transactions t SET is_transfer = 1, category = 'Transferência'
     FROM (SELECT DISTINCT ON (bank_id) bank_id FROM pares) p
     WHERE t.id = p.bank_id
     RETURNING t.id`);
  return rows.length;
}

/**
 * Transferências entre contas suas e entradas que não são renda.
 * @returns {Promise<{titular:number, pares:number, naoRenda:number}>} quantos lançamentos cada regra marcou
 */
export async function markOwnTransfers(db) {
  const [setting] = await db.query("SELECT value FROM settings WHERE key = 'titular'");
  const holder = setting?.value || process.env.TITULAR || "";

  const rows = await db.query(
    `SELECT id, date, description, statement_description, amount_cents, direction, account, source
     FROM transactions WHERE is_transfer = 0 AND transfer_locked = 0 AND source <> 'manual' ORDER BY date, id`);
  const text = (r) => `${r.description} ${r.statement_description || ""}`;
  const marked = new Map(); // id -> regra

  // 1) Pix/TED/transferência com o nome do próprio titular (enviado ou recebido).
  if (holder) {
    for (const r of rows) {
      if (r.source === "extrato" && TRANSFER_WORDS.test(text(r)) && mentionsHolder(text(r), holder)) marked.set(r.id, "titular");
    }
  }

  // 2) Saiu de um banco e entrou em OUTRO banco: mesmo valor, até 1 dia, ambos com cara de transferência.
  const entradas = rows.filter((r) => r.source === "extrato" && r.direction === "entrada" && !marked.has(r.id) && TRANSFER_WORDS.test(text(r)));
  const used = new Set();
  for (const s of rows) {
    if (s.source !== "extrato" || s.direction !== "saida" || marked.has(s.id) || !TRANSFER_WORDS.test(text(s))) continue;
    const banks = bankTokens([s.account]);
    if (!banks.size) continue;
    const e = entradas.find((x) => !used.has(x.id) && x.amount_cents === s.amount_cents && x.account &&
      Math.abs(Date.parse(x.date) - Date.parse(s.date)) <= DAY && !sameBank(x.account, banks));
    if (e) { used.add(e.id); marked.set(s.id, "pares"); marked.set(e.id, "pares"); }
  }

  // 2b) O outro lado de um Pix com o seu nome: o banco B diz "recebido de <você>" (ou "enviado para
  //     <você>"); o lançamento de mesmo valor, até 1 dia, no banco A é a outra ponta, mesmo que o
  //     banco A descreva de outro jeito (ex.: PicPay mostra só "PIX recebido").
  if (holder) {
    const own = (await db.query(
      `SELECT id, date, description, statement_description, amount_cents, direction, account
       FROM transactions WHERE source = 'extrato' AND (is_transfer = 1 OR transfer_locked = 0)`))
      .filter((c) => TRANSFER_WORDS.test(text(c)) && mentionsHolder(text(c), holder));
    const usedOwn = new Set();
    for (const r of rows) {
      if (r.source !== "extrato" || marked.has(r.id) || !TRANSFER_WORDS.test(text(r)) || !r.account) continue;
      const banks = bankTokens([r.account]);
      if (!banks.size) continue;
      const c = own.find((x) => !usedOwn.has(x.id) && x.id !== r.id && x.amount_cents === r.amount_cents &&
        x.direction !== r.direction && x.account && !sameBank(x.account, banks) &&
        Math.abs(Date.parse(x.date) - Date.parse(r.date)) <= DAY);
      if (c) { usedOwn.add(c.id); marked.set(r.id, "pares"); }
    }
  }

  // 3) Entradas que não são renda.
  for (const r of rows) {
    if (r.direction === "entrada" && !marked.has(r.id) && NOT_INCOME.test(text(r))) marked.set(r.id, "naoRenda");
  }
  // 3b) Pix pago com o dinheiro do "Pix no crédito" (mesma conta, mesmo valor, mesmo dia).
  for (const e of rows) {
    if (e.direction !== "entrada" || !PIX_ON_CREDIT.test(text(e))) continue;
    const s = rows.find((x) => x.direction === "saida" && !marked.has(x.id) && x.account === e.account &&
      x.amount_cents === e.amount_cents && x.date === e.date && TRANSFER_WORDS.test(text(x)));
    if (s) marked.set(s.id, "naoRenda");
  }

  if (marked.size) {
    await db.query("UPDATE transactions SET is_transfer = 1, category = 'Transferência' WHERE id = ANY($1)", [[...marked.keys()]]);
  }
  const count = (k) => [...marked.values()].filter((v) => v === k).length;
  return { titular: count("titular"), pares: count("pares"), naoRenda: count("naoRenda") };
}

/** Roda todas as regras (depois de cada sincronização e de cada importação de arquivo). */
export async function classifyTransfers(db) {
  const faturas = await markCardPayments(db);
  return { faturas, ...(await markOwnTransfers(db)) };
}
