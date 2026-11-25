// Nome do banco de cada lançamento, para o filtro "Banco" do app.
// Os nomes de conta variam ("Nu Pagamentos S.A. - Instituição...", "Nubank", "VISA GOLD"); aqui
// viram um nome só. Cartões com nome genérico ("VISA GOLD", "platinum") pegam o banco da própria
// conexão do Open Finance, guardado em account_banks a cada sincronização.

const ALIASES = [
  [/\bnu ?(pagamentos|financeira|bank|conta)\b|\bnubank\b/i, "Nubank"],
  [/bradesco/i, "Bradesco"],
  [/picpay/i, "PicPay"],
  [/ita[uú]/i, "Itaú"],
  [/santander/i, "Santander"],
  [/caixa/i, "Caixa"],
  [/banco do brasil|\bbb\b/i, "Banco do Brasil"],
  [/\binter\b/i, "Inter"],
  [/\bc6\b/i, "C6 Bank"],
  [/mercado ?pago/i, "Mercado Pago"],
  [/sicoob/i, "Sicoob"],
  [/sicredi/i, "Sicredi"],
  [/\bbtg\b/i, "BTG"],
  [/\bxp\b/i, "XP"],
  [/\bneon\b/i, "Neon"],
  [/\bnext\b/i, "Next"],
];

export const MANUAL = "Lançado à mão";

/** Banco reconhecido pelo nome, ou null. */
export function knownBank(name) {
  return ALIASES.find(([re]) => re.test(name || ""))?.[1] ?? null;
}

/** Guarda o banco das contas de uma conexão (todas as contas de um item são do mesmo banco). */
export async function rememberAccountBanks(db, accounts) {
  const names = accounts.map((a) => a.marketingName || a.name).filter(Boolean);
  const bank = accounts.map((a) => knownBank(a.name) || knownBank(a.marketingName)).find(Boolean);
  if (!bank) return;
  for (const account of names) {
    await db.query(
      `INSERT INTO account_banks (account, bank) VALUES ($1, $2)
       ON CONFLICT (account) DO UPDATE SET bank = EXCLUDED.bank`, [account, bank]);
  }
}

export const UNKNOWN = "Banco não informado";

/** @returns {Promise<(account: string|null, source?: string) => string>} */
export async function bankResolver(db) {
  const saved = new Map((await db.query("SELECT account, bank FROM account_banks")).map((r) => [r.account, r.bank]));
  return (account, source) => !account ? (source === "manual" ? MANUAL : UNKNOWN)
    : saved.get(account) || knownBank(account) || account;
}
