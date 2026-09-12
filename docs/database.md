# Banco de dados

SQLite em modo WAL. `data/h2a_system.db`. Migrações versionadas em `core_schema_meta`.

## Isolamento por prefixo

Equivale aos schemas PostgreSQL que o spec §50 sugere:

| Prefixo | Equivalente | Conteúdo |
|---|---|---|
| `core_` | `core.*` | Perfil Mestre, Biblioteca de Currículos, ATS, logs, configuração |
| `gupy_` | `gupy.*` | Vagas, análises, matches, buscas, integração, logs do Gupy |
| `indeed_` | `indeed.*` | O mesmo, para o Indeed |
| `seasonal_` | `seasonal.*` | Ordens de serviço, pacotes, fila, cota, envios |

**Não existe tabela `jobs`.** A §44 do build prompt original a proíbe, e a migração v2
a removeu — preservando as 157 ordens de serviço que estavam nela, migradas para
`seasonal_jobs`.

## Escopo de país

`gupy_jobs` e `indeed_jobs` têm coluna `country` com `UNIQUE(country, external_id)`.
Isso é o que a §50 endossa ("country-specific entities should contain explicit country
scope") e é diferente da coluna `source` proibida: `source` misturaria três produtos
numa tabela; `country` separa dois mercados **dentro** de um produto.

`seasonal_jobs` **não tem** coluna de país — o produto é US-only por definição (§4.3),
e o teste verifica que a coluna não existe.

## Migração v1 → v2

Executada automaticamente no primeiro boot. Em três fases:

1. **Renomear** — tabelas cuja forma mudou viram `<nome>__v1`. Nada é apagado ainda.
2. **Recriar** — o schema v2 é criado do zero.
3. **Backfill e limpar** — os dados que ainda valem voltam, e só então o legado sai.

Preservado, em ordem de importância:

1. `seasonal_applications` — histórico de envios, base da proteção anti-duplicata
2. Ordens de serviço, incluindo as 157 da tabela genérica
3. Documentos, que viram a Biblioteca de Currículos
4. Contagem de cota do dia corrente

Faça backup de `data/h2a_system.db` antes do primeiro boot da v2. A migração já
foi aplicada neste repositório; o backup está em `data/h2a_system.backup-*.db`.

## Garantias no schema

```sql
-- Anti-duplicata de candidatura: garantia do banco, não da aplicação (§62)
UNIQUE(candidate_id, seasonal_job_id, recipient_email)

-- Dedupe por produto e país
UNIQUE(country, external_id)   -- gupy_jobs, indeed_jobs
UNIQUE(job_order_id)           -- seasonal_jobs

-- Cota: uma linha por dia-calendário no fuso configurado
UNIQUE(date_str)               -- seasonal_daily_quota
```
