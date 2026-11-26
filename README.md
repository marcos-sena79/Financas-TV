# Finanças TV

Controle de finanças pessoal em três partes, todas servidas por um único programa que roda no seu PC (ou num mini-servidor) na rede de casa:

| Parte | Onde abre | Para quê |
|---|---|---|
| **App** | celular → `http://IP-DO-PC:3000/` | enviar holerite, extrato e fatura; lançar gastos à mão |
| **Dashboard** | Google TV → `http://IP-DO-PC:3000/tv` | painel visual do mês, atualiza sozinho |
| **Servidor** | PC | lê os arquivos com IA (modelos gratuitos via OpenRouter), guarda tudo no Postgres |

## Publicado na Vercel

- App: https://financas-tv.vercel.app · TV: https://financas-tv.vercel.app/tv
- Banco: Neon Postgres (`financas-db`), ligado ao projeto pela variável `DATABASE_URL`.
- Variáveis na Vercel: `OPENROUTER_API_KEY`, `APP_PASSWORD` (senha de acesso; a mesma está no `.env`), `DATABASE_URL`.
- Publicar uma nova versão: `vercel deploy --prod`
- Trocar a senha: `vercel env rm APP_PASSWORD production`, depois `vercel env add APP_PASSWORD production --sensitive`, depois `vercel deploy --prod` (atualize também o `.env`).
- Na Vercel cada envio tem limite de 4,5 MB (o app comprime fotos; PDFs maiores precisam ser divididos) e a TV atualiza a cada 30 s.
- Rodando no PC sem `DATABASE_URL`, o app usa um Postgres embutido em `data/pgdata`.

## Open Finance (Meu Pluggy)

Puxa extratos e cartões direto dos bancos, sem enviar arquivo. Gratuito para uso pessoal (até 5 conexões).

1. Crie a conta em https://meu.pluggy.ai e conecte seus bancos (a autorização é feita no app de cada banco).
2. Em https://dashboard.pluggy.ai crie uma aplicação, copie o **Client ID** e o **Client Secret**, habilite o conector **MeuPluggy** e crie uma conexão escolhendo "MeuPluggy". Copie o **id** dessa conexão (item).
3. Na Vercel, cadastre `PLUGGY_CLIENT_ID`, `PLUGGY_CLIENT_SECRET` e `PLUGGY_ITEM_IDS` e publique.

O Meu Pluggy atualiza os bancos a cada 24 h; o app busca todo dia às 8h (horário de Brasília) e também pelo botão "Sincronizar agora". Cada transação passa pela mesma conciliação dos uploads; transações pendentes só entram quando confirmadas. Se um banco pedir nova autorização, o aviso aparece no app: renove em meu.pluggy.ai.

## Como a "inteligência" funciona

1. Você envia um arquivo (PDF, foto, CSV ou OFX) de qualquer banco.
2. A IA identifica o tipo (holerite, extrato ou fatura) e devolve cada lançamento com data, valor, entrada/saída, categoria e parcela.
   - **Holerite** → um único lançamento de entrada com o **salário líquido** (bruto e descontos aparecem só como informação).
   - **Extrato** → créditos viram entradas, débitos viram saídas, linhas de saldo são ignoradas.
   - **Fatura** → cada compra vira saída; estornos viram entrada.
   - **Pagamento de fatura** e **transferência entre contas suas** são marcados como *transferência* e ficam fora dos totais, senão o mesmo gasto contaria duas vezes (compra na fatura + pagamento no extrato).
3. A **conciliação** compara cada lançamento com o que já existe no banco:
   - **Já lançado à mão**: mesmo valor e data até 5 dias de diferença de um lançamento manual seu. O manual é confirmado (✓ conferido), não duplicado.
   - **Já importado**: mesmo valor e data até 3 dias de diferença de outro documento (extratos com períodos sobrepostos, ou salário do holerite e do extrato). Vem marcado como "Ignorar".
   - **Novo**: entra normalmente.
4. Você revisa na tela (dá para trocar a categoria ou a ação de cada linha) e confirma. A TV atualiza na hora.

O mesmo arquivo enviado duas vezes é recusado.

## Instalação (Windows)

Precisa do [Node.js](https://nodejs.org) 22.13 ou mais novo e de uma chave da OpenRouter ([openrouter.ai/keys](https://openrouter.ai/keys)).

```bash
npm install
```

Crie um arquivo `.env` na pasta do projeto (veja `.env.example`):

```
OPENROUTER_API_KEY=sk-or-...
APP_PASSWORD=sua-senha
```

Inicie:

```bash
node --env-file=.env src/server.js
```

O terminal mostra os endereços do app e da TV. Se o Windows perguntar sobre o firewall, permita em **redes privadas**.

Para ver o painel com dados fictícios antes de importar algo de verdade:

```bash
npm run demo
```

```bash
set DB_FILE=data/demo.db && node --env-file=.env src/server.js
```

## Colocando na Google TV

Opção mais simples: instale um navegador na TV pela Play Store (ex.: **TV Bro**), abra `http://IP-DO-PC:3000/tv` e deixe em tela cheia. No controle: **◀ ▶** trocam o mês e **OK** volta ao mês atual.

Opção "quiosque": um app como **Fully Kiosk Browser** abre o endereço sozinho quando a TV liga.

Dica: fixe o IP do PC no roteador (reserva de DHCP) para o endereço não mudar.

## No celular

Abra `http://IP-DO-PC:3000/` e use "Adicionar à tela inicial" para ficar com cara de app. Funciona só no Wi-Fi de casa (o servidor não fica exposto na internet).

## Limitações conhecidas

- **PDF com senha** (muitos bancos usam o CPF): o app avisa. Abra o PDF no celular, use *Imprimir → Salvar como PDF* e envie a cópia.
- Faturas muito longas (centenas de linhas) podem precisar ser divididas.
- Não há login: qualquer pessoa no seu Wi-Fi consegue abrir o app.
- A leitura usa modelos **gratuitos** da OpenRouter (lista em `src/extractor.js`, ou na variável `OPENROUTER_MODELS`). Limite: 20 por minuto e 50 por dia (1000 por dia depois de comprar US$ 10 em créditos lá, uma única vez). Os modelos gratuitos mudam com o tempo e erram mais que os pagos: revise a prévia antes de confirmar.
- PDFs são convertidos em texto pelo leitor gratuito da OpenRouter; PDFs escaneados (imagem) podem não ser lidos bem: nesse caso, envie uma foto.
- Privacidade: com modelos gratuitos, o provedor do modelo pode registrar o conteúdo enviado. Revise em openrouter.ai/settings/privacy.

## Estrutura

```
src/server.js      rotas HTTP, envio/confirmação, eventos para a TV
src/extractor.js   prompt e esquema da leitura por IA
src/reconcile.js   regras de conciliação e duplicidade
src/summary.js     números do dashboard
src/db.js          banco SQLite (data/financas.db)
public/index.html  app do celular
public/tv.html     dashboard da TV
test/              testes do fluxo (npm test)
```

## Instalar no celular (PWA)

Abra https://financas-tv.vercel.app no celular e entre com a senha.
- **Android (Chrome):** toque em **Instalar app** no topo (ou menu ⋮ → *Instalar app*).
- **iPhone (Safari):** toque em **Compartilhar** → **Adicionar à Tela de Início**.

O app ganha ícone próprio e abre em tela cheia. Os ícones saem de `node scripts/make-icons.js`;
ao mudar `public/sw.js`, suba a constante `VERSION` para os celulares trocarem o cache.
