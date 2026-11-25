// Banco de dados Postgres.
//  - Na Vercel (ou onde houver DATABASE_URL): Neon, via HTTP (ideal para serverless).
//  - No PC e nos testes: PGlite, um Postgres embutido que grava em data/pgdata (ou só na memória).
// As duas opções expõem a mesma interface:
//   query(sql, params)  -> linhas
//   batch([{ sql, params }, ...]) -> executa tudo numa única transação

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS imports (
     id            SERIAL PRIMARY KEY,
     file_name     TEXT NOT NULL,
     file_hash     TEXT NOT NULL UNIQUE,
     document_type TEXT NOT NULL,
     institution   TEXT,
     period_start  TEXT,
     period_end    TEXT,
     created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  // Valores sempre em centavos (inteiro) para evitar erro de arredondamento.
  `CREATE TABLE IF NOT EXISTS transactions (
     id            SERIAL PRIMARY KEY,
     date          TEXT NOT NULL,               -- YYYY-MM-DD
     description   TEXT NOT NULL,
     amount_cents  INTEGER NOT NULL CHECK (amount_cents > 0),
     direction     TEXT NOT NULL CHECK (direction IN ('entrada','saida')),
     category      TEXT NOT NULL DEFAULT 'Outros',
     account       TEXT,
     source        TEXT NOT NULL CHECK (source IN ('manual','extrato','fatura','holerite')),
     is_transfer   INTEGER NOT NULL DEFAULT 0,  -- pagamento de fatura, transferência entre contas próprias
     installment   TEXT,
     import_id     INTEGER REFERENCES imports(id) ON DELETE SET NULL,
     reconciled    INTEGER NOT NULL DEFAULT 0,  -- lançamento manual confirmado por extrato/fatura
     statement_description TEXT,
     created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(date)`,
  // Id da transação no Open Finance (Pluggy): evita importar a mesma duas vezes.
  `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS external_id TEXT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_tx_external ON transactions(external_id)`,
  // 1 = você marcou/desmarcou "transferência" à mão; as regras automáticas não mexem mais nele.
  `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS transfer_locked INTEGER NOT NULL DEFAULT 0`,
  // Banco de cada conta (para o filtro "Banco"); preenchido na sincronização do Open Finance.
  `CREATE TABLE IF NOT EXISTS account_banks (
     account TEXT PRIMARY KEY,
     bank    TEXT NOT NULL
   )`,
  // Categoria escolhida por você para uma descrição (chave em maiúsculas, espaços simples).
  `CREATE TABLE IF NOT EXISTS category_rules (
     description TEXT PRIMARY KEY,
     category    TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS settings (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS sync_state (
     id           INTEGER PRIMARY KEY,
     last_sync_at TIMESTAMPTZ,
     result       JSONB
   )`,
  // Prévias aguardando confirmação (serverless não guarda nada em memória entre requisições).
  `CREATE TABLE IF NOT EXISTS pending_imports (
     token      TEXT PRIMARY KEY,
     payload    JSONB NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
];

async function neonDb(url) {
  const { neon } = await import("@neondatabase/serverless");
  const sql = neon(url);
  return {
    query: (text, params = []) => sql.query(text, params),
    batch: (items) => sql.transaction(items.map((q) => sql.query(q.sql, q.params ?? []))),
  };
}

async function pgliteDb(dataDir) {
  const { PGlite } = await import("@electric-sql/pglite");
  const pg = dataDir ? new PGlite(dataDir) : new PGlite();
  return {
    query: async (text, params = []) => (await pg.query(text, params)).rows,
    batch: (items) => pg.transaction(async (tx) => {
      const out = [];
      for (const q of items) out.push((await tx.query(q.sql, q.params ?? [])).rows);
      return out;
    }),
    close: () => pg.close(),
  };
}

/**
 * @param {{ url?: string, dataDir?: string|null }} opts
 *   url: string de conexão Postgres (padrão: DATABASE_URL)
 *   dataDir: pasta do PGlite; null = só memória (testes)
 */
export async function openDb({ url = process.env.DATABASE_URL, dataDir = process.env.PGLITE_DIR ?? "data/pgdata" } = {}) {
  const db = url ? await neonDb(url) : await pgliteDb(dataDir);
  for (const stmt of SCHEMA) await db.query(stmt);
  return db;
}
