import express from "express";
import multer from "multer";
import crypto from "node:crypto";
import { openDb } from "./db.js";
import { authRoutes } from "./auth.js";
import { extractDocument, CATEGORIES, UserError, AIError } from "./extractor.js";
import { syncPluggy, pluggyConfigured, PluggyError } from "./pluggy.js";
import { classifyTransfers } from "./transfers.js";
import { categoryResolver, ruleKey } from "./categoryRules.js";
import { bankResolver } from "./banks.js";

const safeEqualStr = (a, b) => {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
};
import { reconcile, toCents } from "./reconcile.js";
import { monthSummary } from "./summary.js";

// A Vercel recusa requisições acima de 4,5 MB; o app comprime fotos antes de enviar.
// Mesma regra de ruleKey() (categoryRules.js), em SQL: maiúsculas, sem espaços duplicados.
const SAME_DESC = String.raw`upper(regexp_replace(trim(description), '\s+', ' ', 'g'))`;
const MAX_UPLOAD = Math.floor(4.4 * 1024 * 1024);
const monthOf = (q) => (/^\d{4}-\d{2}$/.test(q || "") ? q : new Date().toISOString().slice(0, 7));

/**
 * @param {object} opts
 * @param {() => Promise<object>} [opts.getDb]   fábrica do banco (padrão: Neon ou PGlite)
 * @param {Function} [opts.extract]              leitor de documentos (padrão: Claude)
 * @param {string}   [opts.password]             senha de acesso (padrão: APP_PASSWORD)
 */
export function createApp({
  getDb, extract = extractDocument, password = process.env.APP_PASSWORD?.trim(),
  pluggyFetch = fetch, pluggyEnv = process.env, cronSecret,
} = {}) {
  let dbPromise;
  const db = () => (dbPromise ??= (getDb ? getDb() : openDb()).catch((e) => { dbPromise = null; throw e; }));

  const app = express();
  app.set("trust proxy", true);
  app.use(express.json());
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD } });

  // Tarefa agendada da Vercel (vercel.json -> crons). A Vercel envia "Authorization: Bearer <CRON_SECRET>".
  app.get("/api/cron/sync", async (req, res, next) => {
    try {
      const secret = cronSecret ?? process.env.CRON_SECRET?.trim();
      const sent = String(req.headers.authorization || "");
      if (!secret || !safeEqualStr(sent, `Bearer ${secret}`)) return res.status(401).json({ error: "não autorizado" });
      if (!pluggyConfigured(pluggyEnv)) return res.json({ skipped: "Open Finance não configurado" });
      res.json(await syncPluggy(await db(), { fetchImpl: pluggyFetch, env: pluggyEnv }));
    } catch (err) { next(err); }
  });

  // Na internet, sem senha configurada, nada funciona (evita expor suas finanças por engano).
  if (!password && process.env.VERCEL) {
    app.use("/api", (_req, res) => res.status(503).json({ error: "Configure a variável APP_PASSWORD na Vercel." }));
  }
  authRoutes(app, password);

  app.get("/api/categories", (_req, res) => res.json(CATEGORIES));

  // Open Finance: sincronizar agora (botão no app) e situação da última sincronização.
  app.post("/api/sync", async (_req, res, next) => {
    try {
      res.json(await syncPluggy(await db(), { fetchImpl: pluggyFetch, env: pluggyEnv }));
    } catch (err) { next(err); }
  });
  app.get("/api/sync/status", async (_req, res, next) => {
    try {
      const [row] = await (await db()).query(
        "SELECT last_sync_at, result FROM sync_state WHERE id = 1");
      res.json({
        configured: pluggyConfigured(pluggyEnv),
        last_sync_at: row?.last_sync_at ?? null,
        result: typeof row?.result === "string" ? JSON.parse(row.result) : row?.result ?? null,
      });
    } catch (err) { next(err); }
  });

  // 1) Envia o arquivo -> IA lê -> conciliação -> devolve prévia (nada é lançado ainda)
  app.post("/api/upload", upload.single("file"), async (req, res, next) => {
    try {
      if (!req.file) throw new UserError("Nenhum arquivo enviado.");
      const d = await db();
      const fileName = Buffer.from(req.file.originalname, "latin1").toString("utf8");
      const hash = crypto.createHash("sha256").update(req.file.buffer).digest("hex");
      const [already] = await d.query(
        "SELECT to_char(created_at,'DD/MM/YYYY') AS quando FROM imports WHERE file_hash = $1", [hash]);
      if (already) throw new UserError(`Este arquivo já foi importado em ${already.quando}.`);

      const data = await extract(req.file.buffer, req.file.mimetype, fileName);
      if (data.document_type === "desconhecido") {
        throw new UserError("Não reconheci este arquivo como holerite, extrato ou fatura.");
      }
      const items = await reconcile(d, data.transactions);
      const token = crypto.randomUUID();
      await d.query("DELETE FROM pending_imports WHERE created_at < now() - interval '1 day'");
      await d.query("INSERT INTO pending_imports (token, payload) VALUES ($1, $2)",
        [token, JSON.stringify({ fileName, hash, data, items })]);

      res.json({
        token,
        file_name: fileName,
        document_type: data.document_type,
        institution: data.institution,
        period_start: data.period_start,
        period_end: data.period_end,
        payslip: data.payslip,
        warnings: data.warnings,
        items,
      });
    } catch (err) { next(err); }
  });

  // 2) Confirma a importação com as decisões da tela de revisão (tudo numa transação)
  app.post("/api/upload/:token/commit", async (req, res, next) => {
    try {
      const d = await db();
      const [row] = await d.query("SELECT payload FROM pending_imports WHERE token = $1", [req.params.token]);
      if (!row) throw new UserError("Prévia expirada ou já confirmada. Envie o arquivo de novo.");
      const job = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
      const decisions = new Map((req.body.items || []).map((x) => [x.index, x]));
      const source = job.data.document_type;
      const inst = job.data.institution;
      const importId = "(SELECT id FROM imports WHERE file_hash = $1)";
      const counts = { novo: 0, conciliar: 0, ignorado: 0 };
      const categoryOf = await categoryResolver(d);

      const ops = [{
        sql: `INSERT INTO imports (file_name, file_hash, document_type, institution, period_start, period_end)
              VALUES ($1, $2, $3, $4, $5, $6)`,
        params: [job.fileName, job.hash, source, inst, job.data.period_start, job.data.period_end],
      }];
      job.items.forEach((item, index) => {
        const dec = decisions.get(index) || {};
        const action = dec.action || item.action;
        // Escolha na tela de revisão > regra que você criou no app > sugestão da IA.
        const category = CATEGORIES.includes(dec.category) && dec.category !== item.category ? dec.category
          : item.is_transfer ? item.category : categoryOf(item.description, item.category);
        if (action === "conciliar" && item.match) {
          ops.push({
            sql: `UPDATE transactions SET reconciled = 1, statement_description = $2, import_id = ${importId},
                    account = COALESCE(account, $3), date = $4 WHERE id = $5 AND source = 'manual'`,
            params: [job.hash, item.raw_description, inst, item.date, item.match.id],
          });
          counts.conciliar++;
        } else if (action === "novo") {
          ops.push({
            sql: `INSERT INTO transactions (date, description, amount_cents, direction, category, account, source,
                    is_transfer, installment, import_id, statement_description)
                  VALUES ($2, $3, $4, $5, $6, $7, $8, $9, $10, ${importId}, $11)`,
            params: [job.hash, item.date, item.description, item.amount_cents, item.direction, category, inst,
              source, item.is_transfer ? 1 : 0, item.installment, item.raw_description],
          });
          counts.novo++;
        } else {
          counts.ignorado++;
        }
      });
      ops.push({ sql: "DELETE FROM pending_imports WHERE token = $1", params: [req.params.token] });

      try {
        await d.batch(ops);
      } catch (e) {
        if (e?.code === "23505") throw new UserError("Este arquivo já foi importado.");
        throw e;
      }
      await classifyTransfers(d); // pagamento de fatura e dinheiro entre contas suas viram transferência
      res.json(counts);
    } catch (err) { next(err); }
  });

  // Lançamento manual (gasto em dinheiro, ou anotar na hora antes do extrato chegar)
  app.post("/api/transactions", async (req, res, next) => {
    try {
      const { date, description, amount, direction, category } = req.body;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) throw new UserError("Data inválida.");
      if (!description?.trim()) throw new UserError("Informe uma descrição.");
      const cents = toCents(Number(amount));
      if (!(cents > 0)) throw new UserError("Valor inválido.");
      if (!["entrada", "saida"].includes(direction)) throw new UserError("Tipo inválido.");
      const [row] = await (await db()).query(
        `INSERT INTO transactions (date, description, amount_cents, direction, category, source)
         VALUES ($1, $2, $3, $4, $5, 'manual') RETURNING id`,
        [date, description.trim(), cents, direction, CATEGORIES.includes(category) ? category : "Outros"],
      );
      res.status(201).json({ id: row.id });
    } catch (err) { next(err); }
  });

  // Lista com filtros: período (from/to, ou o mês), categoria e banco. Cada linha vem com "bank".
  app.get("/api/transactions", async (req, res, next) => {
    try {
      const d = await db();
      const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || "");
      let { from, to } = req.query;
      if (!isDate(from) || !isDate(to)) {
        const m = monthOf(req.query.month);
        from = `${m}-01`; to = `${m}-31`;
      }
      if (from > to) [from, to] = [to, from];
      const params = [from, to];
      let sql = "SELECT * FROM transactions WHERE date BETWEEN $1 AND $2";
      if (req.query.category) { params.push(req.query.category); sql += ` AND category = $${params.length}`; }
      const rows = await d.query(sql + " ORDER BY date DESC, id DESC LIMIT 5000", params);
      const bankOf = await bankResolver(d);
      const out = rows.map((r) => ({ ...r, bank: bankOf(r.account, r.source) }));
      res.json(req.query.bank ? out.filter((r) => r.bank === req.query.bank) : out);
    } catch (err) { next(err); }
  });

  // Opções dos filtros: bancos que existem nos lançamentos (e categorias).
  app.get("/api/filters", async (_req, res, next) => {
    try {
      const d = await db();
      const bankOf = await bankResolver(d);
      const accounts = await d.query("SELECT DISTINCT account, (source = 'manual') AS manual FROM transactions");
      const banks = [...new Set(accounts.map((r) => bankOf(r.account, r.manual ? "manual" : "")))].sort((a, b) => a.localeCompare(b, "pt-BR"));
      res.json({ banks, categories: CATEGORIES });
    } catch (err) { next(err); }
  });

  app.patch("/api/transactions/:id", async (req, res, next) => {
    try {
      const d = await db();
      const { category, is_transfer } = req.body;
      const id = Number(req.params.id);
      let similarUpdated = 0;
      if (category !== undefined) {
        if (!CATEGORIES.includes(category)) throw new UserError("Categoria inválida.");
        await d.query("UPDATE transactions SET category = $1 WHERE id = $2", [category, id]);
        // "Aplicar aos parecidos": mesma descrição (de qualquer mês), menos transferências,
        // e lembra a escolha para os lançamentos que chegarem depois.
        if (req.body.apply_similar) {
          const [{ description } = {}] = await d.query("SELECT description FROM transactions WHERE id = $1", [id]);
          if (description) {
            similarUpdated = (await d.query(
              `UPDATE transactions SET category = $1
               WHERE ${SAME_DESC} = $2 AND id <> $3 AND is_transfer = 0 AND category <> $1 RETURNING id`,
              [category, ruleKey(description), id])).length;
            await d.query(
              `INSERT INTO category_rules (description, category) VALUES ($1, $2)
               ON CONFLICT (description) DO UPDATE SET category = EXCLUDED.category`, [ruleKey(description), category]);
          }
        }
      }
      if (is_transfer !== undefined) {
        // Escolha manual: trava o lançamento para as regras automáticas não desfazerem.
        // Marcar mantém a categoria (os totais já ignoram transferências), para desmarcar voltar ao que era.
        // Ao desmarcar algo que as regras tinham posto em "Transferência", usa uma categoria neutra.
        await d.query(
          `UPDATE transactions SET is_transfer = $1, transfer_locked = 1,
             category = CASE
               WHEN $1 = 0 AND category = 'Transferência'
                 THEN CASE WHEN direction = 'entrada' THEN 'Outras receitas' ELSE 'Outros' END
               ELSE category END
           WHERE id = $2`,
          [is_transfer ? 1 : 0, id]);
      }
      const [row] = await d.query("SELECT * FROM transactions WHERE id = $1", [id]);
      if (!row) return res.status(404).json({ error: "Lançamento não encontrado." });
      // Quantos outros têm a mesma descrição e outra categoria (o app pergunta se quer aplicar a eles).
      const [{ n }] = await d.query(
        `SELECT count(*)::int AS n FROM transactions
         WHERE ${SAME_DESC} = $1 AND id <> $2 AND is_transfer = 0 AND category <> $3`,
        [ruleKey(row.description), id, row.category]);
      res.json({ ...row, similar: n, similar_updated: similarUpdated });
    } catch (err) { next(err); }
  });

  app.delete("/api/transactions/:id", async (req, res, next) => {
    try {
      await (await db()).query("DELETE FROM transactions WHERE id = $1", [Number(req.params.id)]);
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  app.get("/api/summary", async (req, res, next) => {
    try {
      res.set("Cache-Control", "no-store");
      res.json(await monthSummary(await db(), monthOf(req.query.month)));
    } catch (err) { next(err); }
  });

  app.get("/tv", (_req, res) => res.redirect("/tv.html"));

  app.use((err, _req, res, _next) => {
    if (err instanceof UserError) return res.status(400).json({ error: err.message });
    if (err instanceof PluggyError) return res.status(502).json({ error: err.message });
    if (err instanceof multer.MulterError) {
      return res.status(400).json({
        error: err.code === "LIMIT_FILE_SIZE"
          ? "Arquivo maior que 4 MB. Divida o PDF em partes ou envie uma foto."
          : err.message,
      });
    }
    console.error(err);
    if (err instanceof AIError) return res.status(502).json({ error: err.message });
    res.status(500).json({ error: "Erro inesperado ao processar. Veja os logs do servidor." });
  });

  return app;
}
