// Números do dashboard. Transferências (pagamento de fatura, entre contas próprias)
// ficam de fora dos totais para não contar o mesmo dinheiro duas vezes.

function shiftMonth(month, delta) {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + delta, 1)).toISOString().slice(0, 7);
}

const daysIn = (month) => {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};

export const RECENT_DAYS = 10;
const addDays = (date, n) => new Date(Date.parse(date) + n * 86_400_000).toISOString().slice(0, 10);
/** Hoje no horário de Brasília (YYYY-MM-DD). */
export const todayBR = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });

/**
 * Lançamentos dos últimos 10 dias (sem transferências), terminando no lançamento mais recente até
 * "hoje" (mês atual) ou até o fim do mês escolhido. Ancorar no mais recente evita uma lista vazia
 * enquanto o banco ainda não mandou os lançamentos de ontem/hoje. Pode atravessar a virada do mês.
 */
async function recentDays(db, month, today) {
  const monthEnd = `${month}-${String(daysIn(month)).padStart(2, "0")}`;
  const limit = today && today < monthEnd ? today : monthEnd;
  const [{ last } = {}] = await db.query(
    "SELECT max(date) AS last FROM transactions WHERE is_transfer = 0 AND date <= $1", [limit]);
  if (!last) return { from: null, to: null, rows: [] };
  const from = addDays(last, -(RECENT_DAYS - 1));
  const rows = await db.query(
    `SELECT id, date, description, amount_cents, direction, category, source, reconciled, account
     FROM transactions WHERE is_transfer = 0 AND date BETWEEN $1 AND $2
     ORDER BY date DESC, id DESC LIMIT 500`, [from, last]);
  return { from, to: last, rows };
}

/**
 * Só no mês atual: comparativos de dias e de semanas (gastos, sem transferências).
 *  - days: gasto de cada dia do mês até hoje; avgDaily: média diária dos 90 dias antes do mês
 *  - today / yesterday / sameDayLastWeek: gasto de hoje, de ontem e do mesmo dia da semana passada
 *  - weeks: 8 semanas (segunda a domingo), a última é a atual (parcial)
 *  - weekToDate: esta semana até hoje x semana passada até o mesmo dia da semana
 */
async function currentView(db, month, today) {
  const monthStart = `${month}-01`;
  const weekday = (d) => (new Date(d + "T00:00:00Z").getUTCDay() + 6) % 7; // 0 = segunda
  const curWeek = addDays(today, -weekday(today));
  const firstWeek = addDays(curWeek, -7 * 7);
  const avgFrom = addDays(monthStart, -90);
  const from = avgFrom < firstWeek ? avgFrom : firstWeek;
  const rows = await db.query(
    `SELECT date, SUM(amount_cents)::int AS total FROM transactions
     WHERE direction = 'saida' AND is_transfer = 0 AND date BETWEEN $1 AND $2 GROUP BY date`, [from, today]);
  const byDate = new Map(rows.map((r) => [r.date, r.total]));
  const on = (d) => byDate.get(d) ?? 0;
  const sum = (a, b) => { let t = 0; for (let d = a; d <= b; d = addDays(d, 1)) t += on(d); return t; };

  const days = [];
  for (let d = monthStart; d <= today && d.startsWith(month); d = addDays(d, 1)) days.push({ date: d, total: on(d) });
  const weeks = [];
  for (let k = 7; k >= 0; k--) {
    const start = addDays(curWeek, -7 * k), end = addDays(start, 6);
    weeks.push({ start, end, total: sum(start, end < today ? end : today), current: k === 0 });
  }
  const elapsed = weekday(today); // dias já passados nesta semana, além de hoje
  return {
    today, days,
    avgDaily: Math.round(sum(avgFrom, addDays(monthStart, -1)) / 90),
    todayTotal: on(today), yesterday: on(addDays(today, -1)), sameDayLastWeek: on(addDays(today, -7)),
    weeks,
    weekToDate: { current: sum(curWeek, today), previous: sum(addDays(curWeek, -7), addDays(curWeek, elapsed - 7)), days: elapsed + 1 },
  };
}

export async function monthSummary(db, month, { today = todayBR() } = {}) {
  const prevMonth = shiftMonth(month, -1);
  const firstMonth = shiftMonth(month, -5);

  const [monthly, byCategory, daily, recent, extra, lastImport, sync] = await Promise.all([
    // Receitas e despesas dos últimos 6 meses (inclui o atual e o anterior).
    db.query(
      `SELECT substr(date,1,7) AS month,
         COALESCE(SUM(CASE WHEN direction='entrada' THEN amount_cents END),0)::int AS income,
         COALESCE(SUM(CASE WHEN direction='saida'   THEN amount_cents END),0)::int AS expense
       FROM transactions WHERE is_transfer=0 AND substr(date,1,7) BETWEEN $1 AND $2
       GROUP BY 1`,
      [firstMonth, month],
    ),
    db.query(
      `SELECT category, SUM(amount_cents)::int AS total, COUNT(*)::int AS count
       FROM transactions WHERE direction='saida' AND is_transfer=0 AND substr(date,1,7)=$1
       GROUP BY category ORDER BY total DESC`,
      [month],
    ),
    db.query(
      `SELECT substr(date,1,7) AS month, CAST(substr(date,9,2) AS INTEGER) AS day, SUM(amount_cents)::int AS total
       FROM transactions WHERE direction='saida' AND is_transfer=0 AND substr(date,1,7) IN ($1,$2)
       GROUP BY 1, 2`,
      [month, prevMonth],
    ),
    recentDays(db, month, today),
    db.query(
      `SELECT
         COALESCE(SUM(CASE WHEN category='Salário' AND direction='entrada' THEN amount_cents END),0)::int AS salary,
         COUNT(*) FILTER (WHERE source='manual' AND reconciled=0)::int AS pending_manual
       FROM transactions WHERE substr(date,1,7)=$1`,
      [month],
    ),
    db.query(
      `SELECT file_name, document_type, institution, to_char(created_at,'YYYY-MM-DD') AS created_at
       FROM imports ORDER BY id DESC LIMIT 1`,
    ),
    db.query("SELECT last_sync_at, result FROM sync_state WHERE id = 1"),
  ]);

  const totalsOf = (mon) => {
    const row = monthly.find((r) => r.month === mon);
    return { income: row?.income ?? 0, expense: row?.expense ?? 0 };
  };
  const cumulative = (mon) => {
    const perDay = new Array(daysIn(mon)).fill(0);
    for (const r of daily) if (r.month === mon) perDay[r.day - 1] = r.total;
    let acc = 0;
    return perDay.map((v) => (acc += v));
  };

  const current = totalsOf(month);
  const isCurrent = today && today.slice(0, 7) === month;
  const history = [];
  for (let i = 5; i >= 0; i--) {
    const mon = shiftMonth(month, -i);
    history.push({ month: mon, ...totalsOf(mon) });
  }

  return {
    month,
    income: current.income,
    expense: current.expense,
    balance: current.income - current.expense,
    previous: { month: prevMonth, ...totalsOf(prevMonth) },
    salary: extra[0].salary,
    byCategory,
    cumulative: { current: cumulative(month), previous: cumulative(prevMonth) },
    history,
    recent: recent.rows,
    current: isCurrent ? await currentView(db, month, today) : null,
    recentRange: { from: recent.from, to: recent.to, days: RECENT_DAYS },
    pendingManual: extra[0].pending_manual,
    lastImport: lastImport[0] ?? null,
    lastSync: sync[0]?.last_sync_at ?? null,
    syncWarnings: (() => {
      const r = sync[0]?.result;
      return (typeof r === "string" ? JSON.parse(r) : r)?.avisos ?? [];
    })(),
  };
}
