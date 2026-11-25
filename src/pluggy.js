// Integração com o Open Finance via Meu Pluggy (gratuito para uso pessoal).
// Busca as transações dos bancos conectados e as passa pela mesma conciliação dos uploads:
// lançamento manual é confirmado, o que já existe é ignorado, o resto entra como novo.
import { reconcile } from "./reconcile.js";
import { categoryResolver } from "./categoryRules.js";
import { rememberAccountBanks } from "./banks.js";
import { bankTokens, sameBank, markCardPayments, classifyTransfers } from "./transfers.js";

export { bankTokens, sameBank, markCardPayments };

const API = "https://api.pluggy.ai";

export class PluggyError extends Error {}
export class LinkExpiredError extends PluggyError {}

export function pluggyConfigured(env = process.env) {
  return Boolean(env.PLUGGY_CLIENT_ID && env.PLUGGY_CLIENT_SECRET && env.PLUGGY_ITEM_IDS);
}

function client(fetchImpl, env) {
  let apiKey;
  const call = async (path, { method = "GET", body } = {}) => {
    if (!apiKey) {
      const r = await fetchImpl(`${API}/auth`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId: env.PLUGGY_CLIENT_ID.trim(), clientSecret: env.PLUGGY_CLIENT_SECRET.trim() }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || !body.apiKey) throw new PluggyError("Client ID ou Secret da Pluggy inválidos.");
      apiKey = body.apiKey;
    }
    const r = await fetchImpl(API + path, {
      method,
      headers: { "X-API-KEY": apiKey, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const out = await r.json().catch(() => ({}));
    if (r.status === 404) throw new PluggyError("Conexão não encontrada na Pluggy. Confira PLUGGY_ITEM_IDS.");
    if (!r.ok) throw new PluggyError(`Pluggy respondeu ${r.status}${out.message ? `: ${out.message}` : ""}.`);
    return out;
  };
  return call;
}

// "2026-11-05T00:00:00.000Z" é uma data sem hora: mantém o dia. Com hora, usa o fuso de Brasília.
export function toLocalDate(iso) {
  if (/T00:00:00(\.0+)?Z$/.test(iso)) return iso.slice(0, 10);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date(iso));
}

const CATEGORY_RULES = [
  [/salar|payroll|remunera|proventos|c\/\s*sal\b|conta\s+sal/i, "Salário"],
  [/rent|aluguel|condom|housing|moradia|mortgage/i, "Moradia"],
  [/grocer|supermarket|supermerc|mercado/i, "Mercado"],
  [/food|restaurant|delivery|ifood|alimenta|padaria|lanch|bar\b/i, "Alimentação"],
  [/transport|uber|99app|taxi|fuel|gas station|posto|combust|parking|estaciona|ped[aá]gio|toll/i, "Transporte"],
  [/health|pharma|farm[aá]c|hospital|medic|dent|saude|saúde|drogaria/i, "Saúde"],
  [/educat|school|escola|curso|faculdade|universid/i, "Educação"],
  [/leisure|entertain|cinema|lazer|travel|viagem|hotel|airline/i, "Lazer"],
  [/digital service|streaming|subscription|assinatura|netflix|spotify/i, "Assinaturas"],
  [/electric|energia|water|[aá]gua|telecom|internet|phone|telefon|utilit|g[aá]s\b/i, "Contas e serviços"],
  [/tax|imposto|iof|tarifa|fee|juros|interest|multa/i, "Impostos e taxas"],
  [/invest|aplica|resgate|cdb|poupan|tesouro/i, "Investimentos"],
  [/shopping|compras|clothing|vestu|electronic|eletr[oô]n|amazon|magalu|mercadolivre/i, "Compras"],
  [/transfer|pix|ted\b|doc\b/i, "Transferência"],
];

function categorize(tx) {
  const text = `${tx.category || ""} ${tx.description || ""}`;
  for (const [re, cat] of CATEGORY_RULES) if (re.test(text)) return cat;
  return "Outros";
}

/** Converte uma transação da Pluggy no formato do app (o mesmo que a leitura por IA devolve). */
export function mapTransaction(tx, account) {
  const isCard = account.type === "CREDIT";
  const desc = tx.description || tx.descriptionRaw || "Lançamento";
  const raw = tx.descriptionRaw || tx.description || "";
  const op = String(tx.operationType || "").toUpperCase();

  // Cartão: compra vem positiva (saída), pagamento/estorno negativo (entrada).
  // Conta: o campo "type" diz a direção (DEBIT = saída, CREDIT = entrada).
  const direction = isCard ? (tx.amount >= 0 ? "saida" : "entrada") : (tx.type === "CREDIT" ? "entrada" : "saida");

  // Pagamento de fatura no extrato. Cada banco escreve de um jeito:
  // "PAG FATURA NU", "PAGTO CARTAO", "GASTOS CARTAO DE CREDITO" (Bradesco), "PAGAMENTO CARTAO CREDITO"...
  const billPaymentText = /pag(amento|to)?\.?\s*(de\s*)?(fatura|cart[aã]o)|fatura\s*(cart|nu|ita|inter|c6)|pagamento recebido|gastos?\s+(c\/)?cart[aã]o|cart[aã]o\s+de\s+cr[eé]dito|deb(ito)?\.?\s+(autom\.?\s+)?(fatura|cart[aã]o)/i;
  const isTransfer =
    (isCard && direction === "entrada" && (/PAGAMENTO/.test(op) || /pagamento/i.test(raw + desc))) ||
    (!isCard && direction === "saida" && billPaymentText.test(raw + " " + desc)) ||
    /aplica[cç][aã]o|resgate|transf.*(mesma titularidade|conta pr[oó]pria)/i.test(raw + " " + desc);

  let category = categorize(tx);
  // "TRANSF SALDO C/SAL P/CC": salário passando da conta-salário para a corrente. É receita, não transferência.
  if (!isTransfer && direction === "entrada" && /c\/\s*sal\b|conta\s+sal/i.test(raw + " " + desc)) category = "Salário";
  if (isTransfer) category = "Transferência";
  else if (direction === "entrada" && category !== "Salário" && category !== "Investimentos") category = "Outras receitas";
  else if (direction === "saida" && category === "Outras receitas") category = "Outros";

  const meta = tx.creditCardMetadata || {};
  const installment = meta.installmentNumber && meta.totalInstallments
    ? `${String(meta.installmentNumber).padStart(2, "0")}/${String(meta.totalInstallments).padStart(2, "0")}` : null;

  return {
    external_id: tx.id,
    date: toLocalDate(tx.date),
    description: desc,
    raw_description: raw,
    amount: Math.abs(Number(tx.amount)),
    direction,
    category,
    is_transfer: isTransfer,
    installment,
    source: isCard ? "fatura" : "extrato",
    account: account.marketingName || account.name || null,
  };
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Cria uma conexão "MeuPluggy" (conector 200) e acompanha a autorização.
 * @param {object} o
 * @param {(url: string) => void} o.onUrl      chamado quando o link de autorização fica pronto
 * @param {(msg: string) => void} [o.onStatus] mensagens de progresso
 * @returns {Promise<{ id: string, contas: string[] }>}
 */
export async function connectMeuPluggy({
  fetchImpl = fetch, env = process.env, onUrl, onStatus = () => {}, onItem = () => {},
  existingItemId = null,
  redirectUri = `${(env.APP_URL || "https://financas-tv.vercel.app").replace(/\/$/, "")}/pluggy-ok.html`,
  sleep = sleepMs, timeoutMs = 10 * 60_000, pollMs = 3000,
}) {
  if (!env.PLUGGY_CLIENT_ID || !env.PLUGGY_CLIENT_SECRET) {
    throw new PluggyError("Coloque PLUGGY_CLIENT_ID e PLUGGY_CLIENT_SECRET no .env antes.");
  }
  const call = client(fetchImpl, env);

  let item;
  if (existingItemId) {
    item = { id: existingItemId };
    onStatus(`Acompanhando a conexão ${existingItemId}…`);
  } else {
    // Confirma que o conector MeuPluggy (200) existe e está habilitado na sua aplicação.
    let connectorId = 200;
    try {
      await call("/connectors/200");
    } catch {
      const { results = [] } = await call("/connectors?name=MeuPluggy");
      const found = results.find((c) => /meu\s*pluggy/i.test(c.name));
      if (!found) throw new PluggyError("Conector MeuPluggy não encontrado. Habilite-o na sua aplicação no dashboard da Pluggy.");
      connectorId = found.id;
    }
    item = await call("/items", {
      method: "POST",
      body: { connectorId, parameters: {}, oauthRedirectUri: redirectUri },
    });
    onStatus("Conexão criada. Aguardando o link de autorização…");
  }
  onItem(item.id);

  const deadline = Date.now() + timeoutMs;
  let urlShown = false;
  let lastState = "";
  while (Date.now() < deadline) {
    const cur = await call(`/items/${item.id}`);
    const state = `${cur.status}${cur.executionStatus ? ` / ${cur.executionStatus}` : ""}`;
    if (state !== lastState) { onStatus(`Situação na Pluggy: ${state}`); lastState = state; }
    const p = cur.parameter;
    if (!urlShown && p?.type === "oauth" && p.data && !existingItemId) {
      onUrl(p.data, p.expiresAt ? new Date(p.expiresAt) : null);
      urlShown = true;
      onStatus("Aguardando você autorizar no navegador…");
    }
    // O link vence em poucos minutos; vencido sem autorização, a conexão não serve mais.
    if (cur.executionStatus === "USER_INPUT_TIMEOUT" ||
        (urlShown && p?.expiresAt && cur.status === "WAITING_USER_INPUT" && Date.now() > Date.parse(p.expiresAt) + 15_000)) {
      throw new LinkExpiredError("O link de autorização venceu antes de a Pluggy receber a autorização.");
    }
    if (["SUCCESS", "PARTIAL_SUCCESS"].includes(cur.executionStatus) ||
        ((urlShown || existingItemId) && cur.status === "UPDATED")) {
      const { results: accounts = [] } = await call(`/accounts?itemId=${encodeURIComponent(item.id)}`);
      return { id: item.id, contas: accounts.map((a) => a.marketingName || a.name) };
    }
    if (cur.status === "LOGIN_ERROR" || /ERROR|REVOKED|NOT_GRANTED|INVALID/.test(cur.executionStatus || "")) {
      throw new PluggyError(`A autorização não foi concluída (${cur.executionStatus || cur.status}). Tente de novo.`);
    }
    await sleep(pollMs);
  }
  throw new PluggyError("Tempo esgotado esperando a autorização (10 min). Rode o script de novo.");
}

/**
 * Sincroniza as conexões configuradas em PLUGGY_ITEM_IDS.
 * @returns {Promise<{novo:number, conciliar:number, ignorado:number, pendentes:number, contas:string[], avisos:string[]}>}
 */
export async function syncPluggy(db, { fetchImpl = fetch, env = process.env, days } = {}) {
  if (!pluggyConfigured(env)) {
    throw new PluggyError("Open Finance não configurado (PLUGGY_CLIENT_ID, PLUGGY_CLIENT_SECRET, PLUGGY_ITEM_IDS).");
  }
  const call = client(fetchImpl, env);
  const lookback = Number(days ?? env.PLUGGY_DAYS ?? 60);
  const dateFrom = new Date(Date.now() - lookback * 86_400_000).toISOString().slice(0, 10);
  const summary = { novo: 0, conciliar: 0, ignorado: 0, pendentes: 0, contas: [], avisos: [] };
  const categoryOf = await categoryResolver(db);

  for (const itemId of env.PLUGGY_ITEM_IDS.split(",").map((s) => s.trim()).filter(Boolean)) {
    const item = await call(`/items/${itemId}`);
    if (["LOGIN_ERROR", "WAITING_USER_INPUT"].includes(item.status) ||
        /REVOKED|NOT_GRANTED|CREDENTIALS/.test(item.executionStatus || "")) {
      summary.avisos.push(`${item.connector?.name || "Conexão"}: autorização precisa ser renovada no Meu Pluggy (meu.pluggy.ai).`);
    }
    const { results: accounts = [] } = await call(`/accounts?itemId=${encodeURIComponent(itemId)}`);
    // Acontece quando o compartilhamento no Meu Pluggy muda (ex.: ao conectar outro banco): a conexão
    // continua "ok", mas sem contas. Sem este aviso a sincronização parecia ter dado certo.
    if (!accounts.length) {
      summary.avisos.push("O Meu Pluggy não está compartilhando nenhuma conta com o app. Autorize de novo: npm run pluggy:connect -- " + itemId);
    }
    await rememberAccountBanks(db, accounts);
    // Bancos desta conexão (ex.: "bradesco"): só lançamentos desses bancos podem ser "o mesmo" que
    // uma transação daqui. Sem isso, dois Pix de R$ 50 em bancos diferentes viravam duplicados.
    const banks = bankTokens(accounts.flatMap((a) => [a.name, a.marketingName, item.connector?.name]));
    // Nome do titular (vem do banco): usado para reconhecer Pix/TED entre contas da mesma pessoa.
    const owner = accounts.map((a) => a.owner).find((o) => typeof o === "string" && o.trim().split(/\s+/).length >= 2);
    if (owner) {
      await db.query(
        `INSERT INTO settings (key, value) VALUES ('titular', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [owner.trim()]);
    }

    for (const account of accounts) {
      summary.contas.push(account.marketingName || account.name);
      const txs = [];
      let after = null;
      do {
        const qs = new URLSearchParams({ accountId: account.id, dateFrom });
        if (after) qs.set("after", after);
        const page = await call(`/v2/transactions?${qs}`);
        txs.push(...(page.results || []));
        after = page.next ? (new URL(page.next, API).searchParams.get("after") ?? page.next) : null;
      } while (after);

      // Lançamentos pendentes ainda mudam de valor/id; entram quando forem confirmados.
      const posted = txs.filter((t) => t.status !== "PENDING");
      summary.pendentes += txs.length - posted.length;
      if (!posted.length) continue;

      const known = new Set((await db.query(
        "SELECT external_id FROM transactions WHERE external_id = ANY($1)", [posted.map((t) => t.id)],
      )).map((r) => r.external_id));
      const fresh = posted.filter((t) => !known.has(t.id)).map((t) => mapTransaction(t, account));
      if (!fresh.length) continue;

      // Um lançamento cujo id veio nesta mesma leitura é outra transação viva (ex.: dois cafés iguais
      // no mesmo dia são duas compras). Já um id que não veio mais é de uma conexão antiga: ao
      // reconectar o banco no Meu Pluggy as transações ganham ids novos, e elas são "o mesmo".
      const liveIds = new Set(posted.map((t) => t.id));
      const items = await reconcile(db, fresh, {
        ignore: (row) => (row.external_id != null && liveIds.has(row.external_id)) || !sameBank(row.account, banks),
      });
      const ops = [];
      for (const it of items) {
        if (it.action === "novo") {
          ops.push({
            sql: `INSERT INTO transactions (date, description, amount_cents, direction, category, account, source,
                    is_transfer, installment, statement_description, external_id)
                  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (external_id) DO NOTHING`,
            params: [it.date, it.description, it.amount_cents, it.direction,
              it.is_transfer ? it.category : categoryOf(it.description, it.category), it.account, it.source,
              it.is_transfer ? 1 : 0, it.installment, it.raw_description, it.external_id],
          });
          summary.novo++;
        } else if (it.action === "conciliar") {
          ops.push({
            sql: `UPDATE transactions SET reconciled = 1, statement_description = $1, account = COALESCE(account, $2),
                    date = $3, external_id = $4 WHERE id = $5 AND source = 'manual' AND external_id IS NULL`,
            params: [it.raw_description, it.account, it.date, it.external_id, it.match.id],
          });
          summary.conciliar++;
        } else {
          // Já veio por PDF ou por uma conexão antiga: passa a apontar para o id atual.
          ops.push({
            sql: "UPDATE transactions SET external_id = $1 WHERE id = $2",
            params: [it.external_id, it.match.id],
          });
          summary.ignorado++;
        }
      }
      await db.batch(ops);
    }
  }

  summary.transferencias = await classifyTransfers(db);

  await db.query(
    `INSERT INTO sync_state (id, last_sync_at, result) VALUES (1, now(), $1)
     ON CONFLICT (id) DO UPDATE SET last_sync_at = now(), result = EXCLUDED.result`,
    [JSON.stringify(summary)],
  );
  return summary;
}
