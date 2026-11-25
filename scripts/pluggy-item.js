// Diagnóstico: mostra a situação de uma conexão da Pluggy (sem dados financeiros).
// Uso: node --env-file=.env scripts/pluggy-item.js <id-da-conexão>
const id = process.argv[2];
if (!id) { console.error("Informe o id da conexão."); process.exit(1); }

const auth = await fetch("https://api.pluggy.ai/auth", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ clientId: process.env.PLUGGY_CLIENT_ID?.trim(), clientSecret: process.env.PLUGGY_CLIENT_SECRET?.trim() }),
}).then((r) => r.json());
const get = (p) => fetch("https://api.pluggy.ai" + p, { headers: { "X-API-KEY": auth.apiKey } }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

const item = await get(`/items/${id}`);
const i = item.body;
console.log(JSON.stringify({
  http: item.status,
  status: i.status,
  executionStatus: i.executionStatus,
  error: i.error,
  statusDetail: i.statusDetail,
  connector: i.connector && { id: i.connector.id, name: i.connector.name },
  parameter: i.parameter && { type: i.parameter.type, name: i.parameter.name, expiresAt: i.parameter.expiresAt },
  userAction: i.userAction && { type: i.userAction.type },
  createdAt: i.createdAt, updatedAt: i.updatedAt, lastUpdatedAt: i.lastUpdatedAt, nextAutoSyncAt: i.nextAutoSyncAt,
}, null, 2));
const acc = await get(`/accounts?itemId=${id}`);
console.log(`contas: http ${acc.status}, ${acc.body.results?.length ?? 0} encontrada(s)`, (acc.body.results || []).map((a) => `${a.type}:${a.marketingName || a.name}`));
