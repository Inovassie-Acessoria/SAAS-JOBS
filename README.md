# Job Intelligence Platform

Descoberta, análise ATS e priorização de vagas em **três produtos independentes**:
Gupy, Indeed e Seasonal Jobs. Eles compartilham infraestrutura técnica e **nenhum dado de negócio**.

| Produto | Mercados | Candidatura |
|---|---|---|
| **Gupy** | Brasil e EUA, em áreas separadas | Manual, no site oficial |
| **Indeed** | Brasil e EUA, em áreas separadas | Manual, no site do anunciante |
| **Seasonal Jobs** | Somente EUA (H-2A / H-2B) | E-mail automatizado, dentro de limites configuráveis |

## Como rodar

```bash
npm install
cp .env.example .env      # preencha o que for usar
npm start                 # http://localhost:3000
npm test                  # 228 testes, sem dependência externa
npm run readiness         # o que falta para o sistema rodar sozinho
```

Requer **Node.js 22+** (usa `node:sqlite`, nativo). Sem etapa de build: o front-end é
JavaScript puro servido estaticamente.

Sem credenciais configuradas o sistema roda em **modo fixture** — dados de exemplo,
sempre rotulados como tal na interface. Nada é apresentado como real sem ser real.

## Arquitetura

```
core/                       lógica de domínio, sem I/O e sem banco
  agents/                   os agentes autônomos, todos determinísticos
    truckDriverGate.js      SOC 53-3032.00 + classificação de motorista
    cdlIntelligence.js      exigida antes × obtida depois × preferencial
    truthGuard.js           nenhuma afirmação sem lastro no perfil
    decisionEngine.js       APPLY / REVIEW / DO_NOT_APPLY por regra configurável
    policyGate.js           o portão de toda ação externa
    communicationChannel.js e-mail automático, telefone e WhatsApp manuais
    permissions.js          matriz de capacidades por agente
    stateMachine.js         estados da candidatura e transições válidas
  ai/                       abstração de provedor de LLM, sem SDK de vendor
    aiProvider.js           contrato e prompts por papel
    providers.js            Deterministic · OpenAI · Gemini · Anthropic
    schemas.js              validação da saída estruturada
  security/secretBox.js     AES-256-GCM para segredos em repouso
  ats/                      motor ATS: regras por país + plataforma, versionadas
    rules/index.js          br-general-v1, us-general-v1 + extensões por plataforma
    formatAnalyzer.js       detecção de colunas, tabelas, seções, datas, contato
    atsRuleEngine.js        resolve regras, pontua, gera issues e sugestões
  match/
    skillOntology.js        equivalência semântica com confiança (HIGH/MEDIUM/LOW)
    requirementClassifier.js  obrigatório × preferencial × contextual × ambíguo
    scoreEngine.js          Fit Score e Opportunity Score, com componentes e pesos
  timeline/
    hiringTimelineEngine.js janela de contratação e prioridade 2027
  documents/textExtract.js  extração de PDF e DOCX usando só zlib

services/                   orquestração e persistência
  agentOrchestrator.js      percorre a cadeia de agentes e audita cada passo
  scheduler.js              o despertador: faz os robôs trabalharem sem o usuário
  driverProfileService.js   perfil de motorista — ausência é UNKNOWN, não zero
  awayReport.js             "enquanto você esteve fora"
  readinessService.js       o que falta para a operação autônoma
  aiService.js              resolve o provedor de LLM e contabiliza o custo
  pipeline.js               Import → Normalize → Dedupe → Hard Filters → Pré-filtro → Scores
  boardService.js           fábrica de produto para Gupy e Indeed (tabelas isoladas)
  seasonalService.js        Seasonal Jobs, US-only, com priorização 2027
  seasonalEmailService.js   pacote, validação, fila, cota de 50/dia, retry
  candidateService.js       perfil e currículos POR PLATAFORMA E PAÍS
  atsService.js             ATS Center e ATS Compare
  gmailService.js           OAuth 2.0 — sem senha de aplicativo
  adapters/                 MCP (Gupy/Indeed) e feeds ZIP do DOL, com health check real

config/database.js          schema, migrações versionadas e logging
public/                     SPA em JS puro
tests/                      node:test — ATS, isolamento, timeline, cota
docs/                       arquitetura, banco, integrações, ATS, e-mail
_legacy/                    código da v1, fora do caminho de execução
```

## Os robôs

O sistema trabalha com o computador do usuário **desligado**. O agendador roda no
servidor e acorda os robôs: importar do DOL, classificar, decidir, preparar e
enviar. Ao voltar, o usuário encontra em **Central de Robôs** o resumo do que
aconteceu e a lista do que espera por ele.

Quatro travas impedem que autonomia vire descontrole:

| trava | garante |
|---|---|
| **Truck Driver Gate** | Seasonal só age sobre vagas de motorista. Uma vaga de colheita que "occasionally drives truck" não entra. |
| **Truth Guard** | Nenhum texto afirma o que o perfil não sustenta. Dado `UNKNOWN` bloqueia igual a dado contraditório. |
| **Policy Gate** | Toda ação externa é reavaliada no momento do envio. Fail-closed. |
| **Permissões** | O agente que escreve o e-mail não pode enviá-lo. Só o Gmail Worker envia. |

Detalhes em [docs/agents.md](docs/agents.md).

## Quatro garantias que o código sustenta

**Isolamento de vagas.** Gupy, Indeed e Seasonal têm tabelas próprias com prefixo do
produto. Não existe tabela genérica `jobs`. País é uma coluna dentro de cada produto,
e toda consulta a filtra. Coberto por `tests/isolation.test.js`.

**Isolamento de candidato.** Cada plataforma e país tem perfil e currículos próprios.
Não existe Perfil Mestre nem biblioteca compartilhada — um currículo do Gupy nunca
aparece no Indeed, e um ambiente sem currículo diz isso em vez de usar o de outro.
Ver [docs/isolation.md](docs/isolation.md), coberto por `tests/environment-isolation.test.js`.

**Cota de e-mail.** No máximo 50 candidaturas enviadas com sucesso por dia-calendário,
no fuso configurado. A reserva é atômica: checagem e incremento na mesma instrução SQL.
`tests/quota.test.js` prova isso com **seis processos separados** disputando a última vaga.

**Veracidade.** Nenhuma saída afirma experiência que não esteja no Perfil Mestre.
Requisito crítico sem informação vira `UNRESOLVED`, nunca uma suposição. Cartas de
recomendação só existem por upload — a IA nunca redige uma em nome de terceiros.

## O que este sistema NÃO faz

- Não se candidata por você na Gupy nem no Indeed. Lá o fluxo termina em "abrir a vaga".
- Não prevê aprovação. O ATS Score é uma heurística transparente de leitura automática;
  não existe algoritmo de ATS único entre empregadores.
- Não reescreve seu currículo. Sugere mudanças e mostra em que fato do perfil cada
  sugestão se apoia.
- Não envia WhatsApp por você. Prepara a mensagem; o envio é seu. Um telefone
  listado para recrutamento não é consentimento de WhatsApp.
- Não exige um LLM. Sem provedor configurado, o matching é ontologia + regras
  determinísticas e os textos são montados por template com lastro no perfil.
  Com provedor, a leitura de requisitos ambíguos e a redação melhoram — mas
  nenhuma regra de negócio passa a depender do modelo.

## Documentação

- [Agentes e robôs autônomos](docs/agents.md)
- [Isolamento por plataforma e país](docs/isolation.md)
- [Arquitetura](docs/architecture.md)
- [Banco de dados](docs/database.md)
- [Integrações](docs/integrations.md)
- [Motor ATS](docs/ats-engine.md)
- [Automação de e-mail](docs/email-automation.md)
