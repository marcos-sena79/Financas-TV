// Categorias que você escolheu no app para uma descrição ("MERCADO PAGO" -> "Compras").
// Valem para os lançamentos que chegarem depois (Open Finance e arquivos).

export const ruleKey = (description) => String(description || "").trim().toUpperCase().replace(/\s+/g, " ");

/** @returns {Promise<(description: string, fallback: string) => string>} */
export async function categoryResolver(db) {
  const rules = new Map((await db.query("SELECT description, category FROM category_rules"))
    .map((r) => [r.description, r.category]));
  return (description, fallback) => rules.get(ruleKey(description)) ?? fallback;
}
