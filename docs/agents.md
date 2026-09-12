# Agentes e robôs autônomos

Implementação do spec `antigravity_ai_agents_autonomous_robots_v1`.

O princípio que organiza tudo o que segue está na §0: **o sistema precisa
funcionar com o computador do usuário desligado.** Todo o resto é consequência
disso — o agendador existe porque o usuário não está lá para clicar, e as travas
existem porque ninguém está lá para conferir.

---

## O que NÃO foi construído, e por quê

A §2 abre com uma proibição: *"Do not create a single unrestricted AI agent that
searches, thinks, writes, sends and changes data without controls."*

Não existe aqui um agente que faz tudo. Existe uma cadeia de peças pequenas, cada
uma com entrada declarada, saída declarada e permissão declarada. A diferença
aparece quando algo dá errado: é possível dizer exatamente qual peça bloqueou uma
candidatura, e por quê.

---

## A cadeia

```
DOL feed  →  importação e normalização        services/adapters/dolAdapter.js
                    ↓
             hard filters                     services/pipeline.js
                    ↓
             TRUCK DRIVER GATE                core/agents/truckDriverGate.js     §24-26
                    ↓
             linha do tempo 2027              core/timeline/hiringTimelineEngine.js §30
                    ↓
             CDL e requisitos                 core/agents/cdlIntelligence.js     §28-29
                    ↓
             ATS · Fit · Opportunity          core/ats/ · core/match/
                    ↓
             CANAIS DE CONTATO                core/agents/communicationChannel.js §40-44
                    ↓
             DECISION ENGINE                  core/agents/decisionEngine.js      §16
                    ↓
             pacote de candidatura            services/seasonalEmailService.js   §19
                    ↓
             TRUTH GUARD                      core/agents/truthGuard.js          §17-18
                    ↓
             POLICY GATE                      core/agents/policyGate.js          §53
                    ↓
             fila → Gmail Worker → SENT       services/gmailService.js           §37
```

O orquestrador que percorre essa cadeia é `services/agentOrchestrator.js`.

---

## As quatro travas

Estas são as peças cuja falha silenciosa seria mais cara. Cada uma tem teste
dedicado, e a falha do teste significa que o sistema passou a poder fazer algo
que prometeu não fazer.

### 1. Truck Driver Gate (§24-26)

Seasonal Jobs existe para vagas de **motorista de caminhão**. Regra de negócio
inegociável.

```
SOC 53-3032.00 presente              → TRUCK_DRIVER_CONFIRMED
título inequívoco, sem SOC           → TRUCK_DRIVER_PROBABLE
SOC ou título ambíguo                → REVIEW_REQUIRED  (decisão humana)
ocupação não-motorista + direção incidental → NOT_TRUCK_DRIVER
```

O caso que a §25 antecipa e proíbe: uma vaga de colheita cuja descrição diz
*"may occasionally drive truck"* **não** é vaga de motorista. O portão detecta a
direção incidental explicitamente e rebaixa a classificação.

Sobre os dados reais do DOL hoje: de 167 ordens classificadas, 151 ficaram fora
do alvo, 14 foram para revisão humana e 2 passaram. A maior parte das 14 são
títulos como *"Agricultural Semi-Truck Driver"* com SOC 45-2091 (Agricultural
Equipment Operators) — exatamente o conflito entre título e código que a §26 diz
para não resolver sozinho.

Testes: `tests/truck-driver-gate.test.js`

### 2. Truth Guard (§17-18)

Nenhum texto gerado chega a um empregador sem passar por aqui. O guarda extrai
cada afirmação verificável do texto e pergunta uma coisa só:

> o perfil desta plataforma sustenta esta afirmação?

Três vereditos:

| veredito | significado | resultado |
|---|---|---|
| `SUPPORTED` | o perfil sustenta | passa |
| `UNSUPPORTED` | o perfil contradiz ou não contém | **bloqueia** |
| `UNKNOWN_SOURCE` | o perfil declara UNKNOWN | **bloqueia** |

O terceiro é o que costuma surpreender. Um perfil que não sabe se tem CDL não
está dizendo que não tem — está dizendo que não sabe. Afirmar o desconhecido é
inventar, e a §17 proíbe inventar. Por isso `UNKNOWN` bloqueia igual a mentira.

Categorias auditadas: anos de experiência, CDL, classe, endossos, licenças,
certificações, escolaridade, idiomas, empregadores, autorização de trabalho e
métricas numéricas.

Testes: `tests/truth-guard.test.js`

### 3. Policy Gate (§53)

Toda ação externa passa por aqui, e o portão é *fail-closed*: provedor
desconhecido, ação desconhecida ou entrada incompleta resultam em `DENIED`.

| provedor | ação | resultado |
|---|---|---|
| INDEED | `AUTO_SUBMIT` | `DENIED` — sem exceção por configuração (§71.4) |
| GUPY | `AUTO_SUBMIT` | `DENIED`, salvo capacidade oficial declarada (§20) |
| SEASONAL | `SEND_APPLICATION_EMAIL` | `ALLOWED` com as sete condições da §36 |
| qualquer | `SEND_WHATSAPP` | `DENIED` por padrão (§41, §43) |
| qualquer | `BROWSER_SUBMIT` | `DENIED` (§46) |

O portão é reavaliado **no momento do envio**, não só no preparo: entre montar o
pacote e despachá-lo, a pausa pode ter sido ligada, a cota pode ter acabado, a
vaga pode ter sido reclassificada.

### 4. Permissões por agente (§52, §37)

A separação que mais importa, dita duas vezes no spec:

```
EmailAgent      WRITE_EMAIL_DRAFT     ✓
EmailAgent      SEND_GMAIL            ✗   ← escreve, não envia
GmailWorker     SEND_GMAIL            ✓   ← o único
```

`core/agents/permissions.js` declara a matriz e a audita. `auditSeparation()`
confirma que exatamente um agente pode enviar, e que nenhum agente que fala com
o LLM segura credencial de envio. Roda no boot do servidor e em
`GET /api/core/agents/self-check`.

Testes: `tests/policy-gate.test.js`

---

## Camada de IA (§4-6, §59)

O sistema **funciona inteiro sem nenhum LLM**. O provedor padrão é
`DeterministicProvider`: análise por ontologia curada, cartas montadas por
template com cada bloco condicionado a um fato do perfil.

Com um LLM configurado, ele melhora a leitura de requisitos ambíguos e a redação.
Nenhuma regra de negócio depende dele — a §4 é explícita sobre o que o LLM **não**
pode fazer: cota, duplicata, permissão, autenticação, integridade e regra de
negócio são código determinístico.

```
core/ai/aiProvider.js    contrato + prompts
core/ai/providers.js     Deterministic · OpenAI · Gemini · Anthropic
core/ai/schemas.js       validação de saída estruturada (§6)
services/aiService.js    resolução por configuração + contabilidade de custo
```

Nenhum SDK de fornecedor entra em `dependencies` — a §5 quer o produto
desacoplado do vendor, e um SDK é exatamente esse acoplamento. As chamadas são
HTTP direto, com `fetch` nativo.

**A chave nunca vai para o banco.** O banco guarda o *nome* da variável de
ambiente; o valor fica no servidor. Tentar salvar algo que pareça uma chave de
verdade é recusado com uma mensagem que explica a diferença.

Uma resposta fora do schema é falha do provedor, não resultado aproveitável:
`structured()` tenta corrigir uma vez e, persistindo, degrada para o caminho
determinístico. Uma falha de LLM nunca derruba uma candidatura.

---

## Agendador (§8, §47-49, §63)

O spec recomenda Celery + Beat + Redis. Aqui é um agendador em processo com
estado no banco, pela mesma razão registrada em [architecture.md](architecture.md):
sistema de um usuário só, fila que é uma tabela.

O que a §49 exige de verdade — execução periódica sem o usuário presente — é
atendido porque o processo roda no VPS. Manter o estado no banco em vez do timer
dá quatro coisas: reiniciar não perde o agendamento, o próximo horário é
consultável, a falha de uma tarefa não interrompe as outras, e a auditoria da
§72 cobre também o que rodou sozinho.

| tarefa | intervalo padrão | o que faz |
|---|---|---|
| `seasonal_import` | 24 h | busca o feed do DOL, normaliza, deduplica, pontua |
| `seasonal_agent_chain` | 6 h | truck gate, CDL, canais, decisão |
| `seasonal_prepare_packages` | 6 h | monta pacotes conforme o modo de automação |
| `seasonal_dispatch` | 1 h | processa a fila com cota, prioridade e backoff |
| `seasonal_stale_check` | 12 h | retira da fila ordens fora do período |
| `audit_retention` | 24 h | limpa a trilha além da retenção configurada |

Falhas consecutivas afastam a próxima tentativa (5, 15, 60, 180 min somados ao
intervalo) — não adianta martelar uma integração fora do ar.

Duas travas independentes: `scheduler_enabled` (liga/desliga a automação) e
`global_pause_all_automations` (impede qualquer ação externa, inclusive execução
forçada de tarefa).

---

## Máquina de estados (§51)

```
Seasonal   DISCOVERED → NORMALIZED → FILTERED → ANALYZED → ATS_ANALYZED →
           MATCHED → APPROVED → DOCUMENTS_READY → CONTACT_VALIDATED →
           QUEUED → SENDING → SENT
                              ↘ FAILED · DEFERRED · MANUAL_ACTION_REQUIRED

Gupy/Indeed DISCOVERED → FILTERED → ANALYZED → ATS_ANALYZED → MATCHED →
            APPROVED → PACKAGE_READY → READY_FOR_REVIEW · DISCARDED
```

`SENT` é terminal: um envio registrado não é desfeito, porque é ele que sustenta
a proteção anti-duplicata da §39. Não existe `SENT` na máquina de Gupy e Indeed —
lá quem submete é o usuário.

Transição não declarada é erro, não improviso: `assertTransition()` lança, e a
recusa diz quais transições eram válidas.

---

## Perfil de motorista (§27)

Tabela própria, `seasonal_driver_profiles`, com o vocabulário do produto: CDL,
classe, endossos, transmissão manual, histórico de direção, experiência com
carreta, transporte agrícola.

**Ausência é `null` no banco e `'UNKNOWN'` na leitura.** Não existe default
otimista — um perfil recém-criado não afirma ter CDL, não afirma não ter, e não
afirma histórico limpo. É isso que faz o Truth Guard bloquear qualquer texto que
afirme o contrário, e é isso que leva uma vaga para revisão humana em vez de
enviá-la no escuro.

O usuário pode **retirar** uma afirmação: salvar um campo vazio devolve o campo a
`UNKNOWN`, e isso propaga.

---

## Canais e WhatsApp (§40-44)

```
EMAIL explicitamente listado  → AUTO
PHONE                         → MANUAL
WHATSAPP                      → MANUAL_DRAFT
WEBSITE                       → MANUAL
```

A regra da §41 é a mais fácil de violar por descuido:

> um número de telefone listado para recrutamento **não** estabelece
> consentimento para WhatsApp

O sistema nunca envia WhatsApp sozinho. Ele prepara a mensagem em inglês, com
cada bloco condicionado a um fato do perfil, e cria uma ação manual com o link
`wa.me`. Quem envia é o usuário — inclusive com a automação ligada.

Automação de WhatsApp só existiria com três coisas ao mesmo tempo: API oficial do
WhatsApp Business configurada, opt-in registrado, e suporte declarado pelo
empregador. O Policy Gate exige as três.

---

## Auditoria (§50, §72)

Cada passo grava uma linha em `core_agent_runs`: correlação, produto, agente,
vaga, estado de origem e destino, resultado, resumo, detalhe e duração.

```
GET /api/seasonal/jobs/:id/audit    trilha de uma candidatura
GET /api/core/agent-runs            atividade recente
GET /api/core/scheduler/history     execuções automáticas
```

É isso que permite responder "por que este e-mail saiu?" — ou, mais
frequentemente, "por que este não saiu?".

---

## Prontidão operacional

`services/readinessService.js` responde a uma pergunta só: **o que exatamente
falta para este sistema rodar sozinho?**

```bash
npm run readiness            # relatório em texto
npm run readiness -- --json  # para CI ou monitoramento
```

Sai com código 1 quando há bloqueador, então serve de gate de deploy. As
verificações são agrupadas por capacidade, porque o sistema degrada em camadas:
dá para descobrir vagas sem enviar e-mail, e dá para enviar e-mail sem LLM.

---

## Testes

| arquivo | cobre |
|---|---|
| `tests/truck-driver-gate.test.js` | §24, §25, §26, §66 |
| `tests/truth-guard.test.js` | §17, §18, §65 |
| `tests/cdl-intelligence.test.js` | §28, §29 |
| `tests/policy-gate.test.js` | §16, §51, §52, §53, §71 |
| `tests/autonomy.test.js` | §27, §32, §41, §49, §55, §63, §70, §72 |
| `tests/timeline.test.js` | §30, §67 |
| `tests/quota.test.js` | §38, §39, §69 |
