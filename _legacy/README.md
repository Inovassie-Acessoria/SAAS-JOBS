# Código legado (v1)

Estes arquivos pertencem à versão anterior do produto e **não são carregados** pela
aplicação atual. Foram movidos para cá — não apagados — durante o refactor v2.

## Por que saíram

Todos importavam funções que não existem mais em `config/database.js`
(`logEvent`, `getTodayQuota`, `incrementEmailQuota`, `incrementWhatsappQuota`) e
consultavam tabelas removidas na migração v2 (`jobs`, `candidate_profile`,
`resumes`, `system_settings`). Nenhum deles era alcançável a partir do `server.js`.

## O que os substituiu

| Legado | Substituto na v2 |
|---|---|
| `gupyService`, `indeedService` | `services/boardService.js` (fábrica por produto/país) |
| `gupyAdapter`, `indeedAdapter` | `services/adapters/mcpClient.js` (com health check real) |
| `seasonalJobsService` | `services/seasonalService.js` |
| `seasonalJobsAdapter`, `dolService` | `services/adapters/dolAdapter.js` (HTTP real) |
| `gmailOAuthService`, `emailService` | `services/gmailService.js` (OAuth 2.0, sem senha de app) |
| `claudeService`, `classifierService` | `core/match/*`, `core/ats/*` |
| `settingsService` | `core_system_settings` + configuração por produto |
| `imapService`, `whatsappService`, `templatesService`, `schedulerService` | sem substituto — fora do escopo do spec atual |

## Podem ser apagados?

Sim, quando você confirmar que nada aqui precisa voltar. WhatsApp e IMAP eram
funcionalidades reais da v1 que o spec atual não pede; se voltarem ao escopo,
partem daqui.
