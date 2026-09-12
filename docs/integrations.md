# Integrações

## Princípio

Toda integração é um adapter com **health check que pode reprovar**. Na v1,
`test_connection()` declarava `const isReachable = true` e testava essa constante —
o botão não conseguia falhar. Agora o teste executa I/O real e classifica o resultado.

## Estados

| Estado | Significado |
|---|---|
| `HEALTHY` | Conectado e operando |
| `DEGRADED` | Funcionando com dados de exemplo, ou provedor limitando |
| `REQUIRES_ATTENTION` | Autenticação expirada, ou ferramenta necessária ausente |
| `DISCONNECTED` | Servidor inalcançável |
| `NOT_CONFIGURED` | Sem endereço configurado |
| `ERROR` | Resposta em formato inesperado |

O `/api/core/health` reporta a **pior** condição entre as integrações. Não existe
caminho que retorne `HEALTHY` com integração caída.

## Diagnóstico em etapas

O teste de conexão MCP roda e reporta cada passo separadamente, então a interface
consegue dizer **onde** falhou:

```
Servidor alcançável      ✓  https://…/mcp
Protocolo MCP            ✓  Versão 2024-11-05
Autenticação             ✓  Token aceito
Ferramentas detectadas   ✓  search_jobs, get_job_details
Ferramentas necessárias  ✕  Ausentes: search_jobs
```

## Mensagens de erro

Erro técnico vira mensagem acionável (spec §42):

| Situação | O que o usuário vê |
|---|---|
| HTTP 401/403 | "A autenticação expirou ou foi recusada. Reconecte a conta para continuar buscando vagas." |
| HTTP 429 | "O serviço está limitando as requisições no momento. Tente novamente em alguns minutos." |
| HTTP 5xx | "O serviço externo está indisponível no momento. Suas vagas e análises já salvas estão seguras." |
| Timeout | "A conexão excedeu 8 segundos sem resposta. Suas vagas já salvas continuam disponíveis." |
| Resposta não-JSON | "A resposta do serviço não pôde ser interpretada. A integração pode ter mudado de formato." |

O detalhe técnico vai para os logs do produto, com `correlation_id`.

## Credenciais

A **URL** do MCP é configurada pela interface e fica no banco.
O **token** vem de variável de ambiente (`GUPY_MCP_TOKEN`, `INDEED_MCP_TOKEN`) e
nunca é gravado no banco. O logger redige qualquer chave que case com
`token|secret|password|senha|api_key|authorization|refresh|access_token` — há teste
verificando que o valor não vaza para `core_audit_logs`.

## Modo fixture

Sem integração configurada, cada adapter opera com dados de exemplo. A resposta
sempre marca `fixtureMode: true`, e a interface rotula a origem — em nenhum ponto
dados de exemplo são apresentados como reais.

Isso é o que o spec §0.7 pede: quando falta credencial, crie o adapter, a tela de
configuração, o teste de conexão e o mock, em vez de bloquear o desenvolvimento.

## Contrato do adapter MCP

```
testConnection()   diagnóstico em etapas, pode reprovar
healthCheck()      estado resumido
callTool(nome, args)
searchJobs(params)
getJobDetails(id)
```

O cliente fala JSON-RPC 2.0 sobre HTTP: `initialize`, `tools/list`, `tools/call`.
Só métodos efetivamente suportados são chamados — nada de inventar capacidade.

## DOL Seasonal Jobs

O adapter normaliza registros ETA-790 tolerando variação de nomes de campo
(`job_order_id` / `case_number` / `eta_case_number`, e assim por diante) e detecta
o método de candidatura a partir do que o registro traz:

| Registro traz | Método | Automação |
|---|---|---|
| E-mail | `EMAIL` | Elegível |
| URL | `WEBSITE` | Ação manual |
| Telefone | `PHONE` | Ação manual |
| Nada disso | `UNKNOWN` | Ação manual |

O envio automático só acontece quando a própria ordem fornece um endereço de
e-mail de candidatura. O sistema **não** busca e-mails corporativos em outras fontes.

Registros sem `job_order_id` são rejeitados e contabilizados, não silenciosamente
descartados.
