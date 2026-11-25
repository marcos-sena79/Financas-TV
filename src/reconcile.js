// Conciliação: cruza o que veio do documento com o que já está no banco.
//  - "conciliar": é um gasto/receita que você já tinha lançado à mão -> confirma o manual
//  - "duplicado": já veio de outro documento (ex.: extratos com período sobreposto) -> ignora
//  - "novo":      ainda não existe -> cria

const DAY = 86_400_000;
const MANUAL_WINDOW_DAYS = 5;   // lançamento manual costuma ter data aproximada
const DOC_WINDOW_DAYS = 3;      // compensação de cartão/PIX pode mudar a data em 1-3 dias

export const toCents = (reais) => Math.round(reais * 100);

const daysBetween = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / DAY;

function normalize(text) {
  return (text || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2);
}

/** Similaridade simples entre descrições (0..1), por palavras em comum. */
export function similarity(a, b) {
  const wa = new Set(normalize(a));
  const wb = new Set(normalize(b));
  if (!wa.size || !wb.size) return 0;
  let common = 0;
  for (const w of wa) if (wb.has(w) || [...wb].some((x) => x.startsWith(w) || w.startsWith(x))) common++;
  return common / Math.min(wa.size, wb.size);
}

/**
 * @param {{ query: Function }} db
 * @param {Array} extracted transações vindas do extractor (valores em reais)
 * @param {{ ignore?: (row: object) => boolean }} [opts] linhas existentes que não podem ser "o mesmo lançamento"
 * @returns {Promise<Array>} cada item com { ...tx, amount_cents, action, match }
 */
export async function reconcile(db, extracted, { ignore = () => false } = {}) {
  const dates = extracted.map((t) => t.date).sort();
  if (!dates.length) return [];
  const from = new Date(Date.parse(dates[0]) - MANUAL_WINDOW_DAYS * DAY).toISOString().slice(0, 10);
  const to = new Date(Date.parse(dates.at(-1)) + MANUAL_WINDOW_DAYS * DAY).toISOString().slice(0, 10);

  const existing = (await db.query("SELECT * FROM transactions WHERE date BETWEEN $1 AND $2", [from, to]))
    .filter((row) => !ignore(row));
  // Escolha global: primeiro os pares mais parecidos. Antes cada item pegava o melhor par livre na ordem
  // em que chegava, e um Pix de R$ 30 para "Rafael" podia levar o par de outro Pix de R$ 30 para
  // "Leonardo" três dias antes, deixando o do Leonardo entrar duplicado.
  const pairs = [];
  extracted.forEach((tx, i) => {
    const amount_cents = toCents(tx.amount);
    for (const ex of existing) {
      if (ex.direction !== tx.direction || ex.amount_cents !== amount_cents) continue;
      const days = daysBetween(ex.date, tx.date);
      const isManualPending = ex.source === "manual" && !ex.reconciled;
      const window = isManualPending ? MANUAL_WINDOW_DAYS : DOC_WINDOW_DAYS;
      if (days > window) continue;
      const sim = similarity(ex.statement_description || ex.description, tx.raw_description || tx.description);
      // Pontuação: data mais próxima e descrição parecida ganham; manual pendente tem prioridade.
      const score = (1 - days / (window + 1)) + sim + (isManualPending ? 0.5 : 0);
      pairs.push({ i, ex, score, days, isManualPending });
    }
  });
  pairs.sort((a, b) => b.score - a.score || a.i - b.i || a.ex.id - b.ex.id);
  const chosen = new Map(); // índice do item -> par
  const used = new Set();
  for (const p of pairs) {
    if (chosen.has(p.i) || used.has(p.ex.id)) continue;
    chosen.set(p.i, p);
    used.add(p.ex.id);
  }

  return extracted.map((tx, i) => {
    const amount_cents = toCents(tx.amount);
    const best = chosen.get(i);
    if (!best) return { ...tx, amount_cents, action: "novo", match: null };
    return {
      ...tx,
      amount_cents,
      action: best.isManualPending ? "conciliar" : "duplicado",
      match: {
        id: best.ex.id,
        date: best.ex.date,
        description: best.ex.description,
        source: best.ex.source,
        days_apart: Math.round(best.days),
      },
    };
  });
}
