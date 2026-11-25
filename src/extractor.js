// "Inteligência" do app: envia o arquivo a um modelo via OpenRouter e recebe dados estruturados.
// Por padrão usa só modelos gratuitos (":free"), com reservas caso o primeiro esteja indisponível.
import { z } from "zod";

export const CATEGORIES = [
  "Salário", "Outras receitas", "Moradia", "Mercado", "Alimentação", "Transporte",
  "Saúde", "Educação", "Lazer", "Compras", "Assinaturas", "Contas e serviços",
  "Impostos e taxas", "Investimentos", "Transferência", "Outros",
];

// Modelos gratuitos que aceitam imagem e resposta em JSON estruturado (verificados em 18/11/2026).
// A lista de gratuitos da OpenRouter muda com frequência: dá para trocar pela variável OPENROUTER_MODELS
// (ids separados por vírgula, em ordem de preferência).
const DEFAULT_MODELS = [
  "nvidia/nemotron-3.5-super-vl:free",
  "particle-ai/particle-1:free",
  "inclusionai/ling-3.2-flash:free",
];

const Transaction = z.object({
  date: z.string().describe("Data no formato YYYY-MM-DD"),
  description: z.string().describe("Descrição limpa e legível do lançamento"),
  raw_description: z.string().describe("Texto exatamente como aparece no documento"),
  amount: z.number().describe("Valor absoluto, sempre positivo, em reais"),
  direction: z.enum(["entrada", "saida"]),
  category: z.enum(CATEGORIES),
  is_transfer: z.boolean().describe(
    "true para movimentações que não são receita nem despesa real: pagamento de fatura de cartão, " +
    "transferência entre contas do próprio titular, aplicação/resgate de investimento próprio",
  ),
  installment: z.string().nullable().describe('Parcela no formato "03/10", ou null'),
});

const Extraction = z.object({
  document_type: z.enum(["holerite", "extrato", "fatura", "desconhecido"]),
  institution: z.string().nullable().describe("Banco, emissor do cartão ou empresa pagadora"),
  period_start: z.string().nullable().describe("YYYY-MM-DD"),
  period_end: z.string().nullable().describe("YYYY-MM-DD"),
  payslip: z.object({
    employer: z.string().nullable(),
    reference_month: z.string().nullable().describe("YYYY-MM"),
    payment_date: z.string().nullable().describe("YYYY-MM-DD"),
    gross: z.number().nullable(),
    total_deductions: z.number().nullable(),
    net: z.number().describe("Salário líquido efetivamente recebido"),
  }).nullable(),
  transactions: z.array(Transaction),
  warnings: z.array(z.string()).describe("Dúvidas ou trechos ilegíveis, em português"),
});

const JSON_SCHEMA = z.toJSONSchema(Extraction);

const SYSTEM = `Você extrai dados financeiros de documentos brasileiros: holerites (contracheques), extratos bancários e faturas de cartão de crédito, de qualquer banco ou app (Nubank, Itaú, Bradesco, Santander, Banco do Brasil, Caixa, Inter, C6, PicPay, Mercado Pago, etc.). Os layouts variam; entenda o significado, não dependa do formato.

Regras:
- Identifique o tipo do documento.
- HOLERITE: preencha "payslip". Gere UMA transação de "entrada", categoria "Salário", com o valor LÍQUIDO e a data de pagamento (se não houver, use o último dia do mês de referência). Não lance os descontos como gastos.
- EXTRATO: cada linha de movimentação vira uma transação. Créditos = "entrada", débitos = "saida". Ignore linhas de saldo (saldo anterior, saldo do dia, saldo final).
- FATURA DE CARTÃO: cada compra/encargo é "saida". Estornos e créditos na fatura são "entrada". A linha de pagamento da fatura anterior ("pagamento recebido", "pagamento efetuado") é is_transfer=true, direção "entrada".
- No extrato, o pagamento da fatura do cartão é is_transfer=true (o gasto real já está nas compras da fatura; contar os dois duplicaria a despesa). O mesmo para transferências entre contas do próprio titular e aplicações/resgates de investimento próprio.
- Datas sem ano (comum em faturas): deduza o ano pelo período/vencimento do documento. Em parceladas, registre a parcela em "installment" e use o valor da parcela, não o total.
- Valores sempre positivos, com ponto decimal (1234.56); o sinal vai em "direction".
- "category" deve ser exatamente uma destas: ${CATEGORIES.join(", ")}.
- Se algo estiver ilegível ou ambíguo, registre em "warnings" em vez de inventar.
- Documento que não é financeiro: document_type "desconhecido" e transactions vazio.

Responda SOMENTE com um objeto JSON que siga este JSON Schema, sem texto antes ou depois:
${JSON.stringify(JSON_SCHEMA)}`;

export class UserError extends Error {}
/** Falha do serviço de IA, já com mensagem pronta para mostrar ao usuário. */
export class AIError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

/**
 * @param {Buffer} buffer conteúdo do arquivo
 * @param {string} mimeType
 * @param {string} fileName
 * @param {{ fetchImpl?: typeof fetch }} [opts] permite simular a OpenRouter nos testes
 */
export async function extractDocument(buffer, mimeType, fileName, { fetchImpl = fetch } = {}) {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) throw new AIError("Chave da OpenRouter ausente. Configure a variável OPENROUTER_API_KEY.");

  const parts = [{
    type: "text",
    text: `Nome do arquivo: ${fileName}. Hoje é ${new Date().toISOString().slice(0, 10)}. Extraia os dados.`,
  }];
  let usesPdf = false;
  const lower = fileName.toLowerCase();

  if (mimeType === "application/pdf" || lower.endsWith(".pdf")) {
    if (buffer.includes("/Encrypt")) {
      throw new UserError(
        "Este PDF está protegido por senha (muitos bancos usam o CPF). Abra no celular, " +
        "use \"Imprimir > Salvar como PDF\" para gerar uma cópia sem senha e envie de novo.",
      );
    }
    usesPdf = true;
    parts.push({
      type: "file",
      file: { filename: fileName, file_data: `data:application/pdf;base64,${buffer.toString("base64")}` },
    });
  } else if (/^image\/(png|jpeg|gif|webp)$/.test(mimeType)) {
    parts.push({ type: "image_url", image_url: { url: `data:${mimeType};base64,${buffer.toString("base64")}` } });
  } else if (/\.(csv|ofx|qfx|txt)$/.test(lower) || mimeType.startsWith("text/")) {
    parts.push({ type: "text", text: `Conteúdo do arquivo "${fileName}":\n\n${decodeText(buffer)}` });
  } else {
    throw new UserError("Formato não suportado. Envie PDF, foto (JPG/PNG), CSV ou OFX.");
  }

  const models = (process.env.OPENROUTER_MODELS || DEFAULT_MODELS.join(","))
    .split(",").map((m) => m.trim()).filter(Boolean);

  const body = {
    models,
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: parts },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "extracao_financeira", strict: true, schema: JSON_SCHEMA },
    },
    temperature: 0,
    max_tokens: 32000,
    // Leitor de PDF gratuito da OpenRouter (converte o PDF em texto antes de mandar ao modelo).
    ...(usesPdf ? { plugins: [{ id: "file-parser", pdf: { engine: "cloudflare-ai" } }] } : {}),
  };

  let res;
  try {
    res = await fetchImpl("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": process.env.APP_URL || "https://financas-tv.vercel.app",
        "X-OpenRouter-Title": "Financas TV",
        "X-OpenRouter-App-Visibility": "hidden",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(280_000),
    });
  } catch (e) {
    if (e?.name === "TimeoutError") throw new AIError("O modelo demorou demais para responder. Tente de novo.");
    throw new AIError("Não consegui falar com a OpenRouter. Verifique a conexão e tente de novo.");
  }

  const payload = await res.json().catch(() => ({}));
  if (!res.ok || payload.error) throw openRouterError(res.status, payload);

  const choice = payload.choices?.[0];
  const text = choice?.message?.content;
  if (!text) throw new AIError("O modelo respondeu vazio. Tente de novo (os modelos gratuitos às vezes falham).");
  if (choice.finish_reason === "length") {
    throw new UserError("Documento grande demais para uma leitura só. Divida o PDF em partes menores.");
  }

  try {
    return Extraction.parse(normalize(parseJson(text)));
  } catch {
    throw new AIError(
      `O modelo (${payload.model || "gratuito"}) devolveu uma resposta fora do formato. Tente de novo.`);
  }
}

function openRouterError(status, payload) {
  const code = payload?.error?.code ?? status;
  const msg = String(payload?.error?.message || "");
  if (code === 401) return new AIError("Chave da OpenRouter inválida. Confira OPENROUTER_API_KEY.", 401);
  if (code === 402) {
    return new AIError("A conta da OpenRouter está com saldo negativo, o que bloqueia até os modelos gratuitos.", 402);
  }
  if (code === 429) {
    return new AIError(
      "Limite dos modelos gratuitos atingido (20 por minuto / 50 por dia). Espere um pouco e tente de novo.", 429);
  }
  if (code === 404 || /no endpoints|not a valid model/i.test(msg)) {
    return new AIError(
      "Os modelos gratuitos configurados não estão disponíveis agora. Atualize OPENROUTER_MODELS.", 404);
  }
  if (code === 413) return new AIError("Arquivo grande demais para o modelo. Divida o PDF em partes.", 413);
  return new AIError(`A leitura pela IA falhou (${code}). Tente de novo em alguns minutos.`, Number(code) || 502);
}

// Alguns modelos gratuitos embrulham o JSON em ```json ... ``` ou escrevem algo antes.
function parseJson(text) {
  const cleaned = text.replace(/^\s*```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try { return JSON.parse(cleaned); } catch {}
  const start = cleaned.indexOf("{"), end = cleaned.lastIndexOf("}");
  return JSON.parse(cleaned.slice(start, end + 1));
}

// Corrige deslizes comuns de modelos menores antes da validação rígida.
function normalize(data) {
  const num = (v) => {
    if (typeof v === "number" || v == null) return v;
    const s = String(v).replace(/[R$\s]/g, "");
    return Number(s.includes(",") ? s.replace(/\./g, "").replace(",", ".") : s);
  };
  data.warnings ??= [];
  data.transactions = (data.transactions ?? []).map((t) => ({
    ...t,
    raw_description: t.raw_description ?? t.description ?? "",
    amount: Math.abs(num(t.amount)),
    category: CATEGORIES.includes(t.category) ? t.category : "Outros",
    is_transfer: Boolean(t.is_transfer),
    installment: t.installment || null,
  }));
  if (data.payslip) {
    for (const k of ["gross", "total_deductions", "net"]) data.payslip[k] = num(data.payslip[k]);
  }
  return data;
}

// Extratos CSV/OFX de bancos brasileiros muitas vezes vêm em Latin-1.
function decodeText(buffer) {
  const utf8 = buffer.toString("utf8");
  return utf8.includes("�") ? buffer.toString("latin1") : utf8;
}
