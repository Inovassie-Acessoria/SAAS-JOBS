# Arquitetura

## Princípio central

Três produtos independentes que compartilham **infraestrutura técnica** e
**nenhum dado de negócio**. O spec permite o primeiro (§1) e proíbe o segundo (§50, §76).

Na prática isso significa:

- `services/boardService.js` é uma **fábrica**: Gupy e Indeed usam o mesmo código,
  cada um com seu descritor de tabelas. Nenhuma consulta cruza a fronteira.
- `services/pipeline.js` é genérico, parametrizado pelas tabelas do produto que o chama.
- O isolamento é verificado por teste, não por convenção — ver `tests/isolation.test.js`.

## Camadas

```
  HTTP            server.js — rotas, validação de entrada, tratamento de erro
    │
  Agendador       services/scheduler.js — acorda os robôs sem o usuário presente
    │
  Serviço         services/* — orquestração, persistência, regras de produto
    │
  Domínio         core/* — sem I/O, sem banco, testável isoladamente
    │
  Adapter         services/adapters/* — MCP e feed do DOL
```

`core/` não importa nada de `services/` nem de `config/`. É essa separação que
permite testar o motor ATS, a priorização 2027, o Truck Driver Gate e o Truth
Guard sem subir banco nem servidor — e é por isso que os agentes determinísticos
vivem em `core/agents/`, não em `services/`.

## Fluxo de uma busca

```
adapter.searchJobs()          I/O externo, ou fixture rotulada
        ↓
spec.normalize()              formato do produto → schema interno
        ↓
pipeline.run()
    ├─ upsert + dedupe        dentro do produto apenas (UNIQUE por país+id externo)
    ├─ hard filters           determinísticos, antes de qualquer análise
    ├─ cache por hash         não reanalisa vaga que não mudou
    ├─ pré-filtro semântico   com proteção contra esvaziar o lote inteiro
    ├─ computeFitScore        componentes + pesos + evidência
    ├─ computeOpportunityScore
    └─ buildConcerns          só o que for materialmente relevante
        ↓
persistência                  scores, componentes e versão do algoritmo
```

## Versionamento de algoritmo

Toda análise grava a versão que a produziu: `fit-v1`, `opportunity-v1`,
`us-gupy-v1`, `analysis-v1`. Mudar um algoritmo no futuro não reescreve
silenciosamente análises antigas — elas continuam identificadas pela versão que
as gerou (spec §52, §55).

## Decisão de stack

O spec recomenda Next.js, FastAPI, PostgreSQL, pgvector, Redis e Celery.
**Esta implementação usa Express, JavaScript puro e `node:sqlite`.**

Justificativa: o sistema é de usuário único, roda localmente e não tem carga
concorrente que justifique a infraestrutura distribuída. SQLite em modo WAL
atende — inclusive a garantia de cota atômica sob múltiplos processos, que é
o requisito mais exigente e está provado em teste.

O que essa escolha custa, declarado explicitamente:

| Recurso do spec | Situação |
|---|---|
| PostgreSQL schemas | Substituído por prefixo de tabela (`gupy_`, `indeed_`, `seasonal_`, `core_`) |
| pgvector / embeddings | Ausente. A equivalência semântica é por ontologia curada, não por vetores |
| Redis + Celery | Ausente. A fila é uma tabela |
| Celery Beat | Substituído por `services/scheduler.js` — agendador em processo com estado no banco. Ver [agents.md](agents.md) |
| Next.js / React / TS | Ausente. SPA em JS puro, sem build |
| Docker Compose | Ausente. `npm start` sobe tudo |

Migrar para a stack recomendada é possível sem reescrever `core/` — é a camada
que não conhece nem banco nem HTTP.
