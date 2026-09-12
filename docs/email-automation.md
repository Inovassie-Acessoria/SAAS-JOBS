# Automação de e-mail — Seasonal Jobs

Este é o único produto que envia candidaturas. Gupy e Indeed terminam em
"abrir a vaga original".

## Fluxo

```
ordem com e-mail de candidatura
        ↓
seleção de currículo         entre os EXISTENTES, com justificativa
        ↓
carta de apresentação        só com fatos do Perfil Mestre
        ↓
anexos                       currículo + cartas de recomendação enviadas pelo usuário
        ↓
validação                    13 checagens; qualquer bloqueante impede o envio
        ↓
decisão de revisão           conforme o modo configurado
        ↓
fila                         ordenada por janela de contratação, depois por score
        ↓
reserva atômica de cota      máx. 50/dia no fuso configurado
        ↓
envio via Gmail (OAuth 2.0)
        ↓
registro permanente          base da proteção anti-duplicata
```

## As quatro travas

### 1. Cota diária

Reserva atômica: a checagem e o incremento acontecem na mesma instrução SQL.

```sql
UPDATE seasonal_daily_quota
   SET count_sent = count_sent + 1
 WHERE date_str = ? AND count_sent < max_limit;
```

Sob concorrência, só uma execução obtém `changes === 1` quando resta uma vaga.
`tests/quota.test.js` prova isso com **seis processos separados** disputando a
última vaga: exatamente um passa, e a contagem final é 50.

O teto de 50 é do produto: nenhuma configuração o eleva. Valores **menores** são
respeitados. A virada do dia usa o fuso de `application_timezone`, não UTC.

Se o envio falhar, a reserva é devolvida — a cota conta envios **bem-sucedidos**.

### 2. Anti-duplicata

`UNIQUE(candidate_id, seasonal_job_id, recipient_email)` no schema. Verificado
antes de reservar cota. Destinatários diferentes na mesma vaga (empregador e
representante legal) são permitidos.

### 3. Pausa

Primeira verificação de `processQueue()`. Com a pausa ativa a descoberta, a
análise e o preparo continuam; só o envio para.

### 4. Validação

Treze checagens, das quais onze bloqueiam:

```
vaga existe · vaga no período (aviso) · e-mail existe · formato válido
· não é duplicata · perfil mínimo preenchido · currículo selecionado
· arquivo do currículo em disco · anexos existem · anexos legíveis
· corpo gerado · assunto gerado · cota disponível (aviso)
```

Nada é marcado `PASSED` por padrão. Sem currículo, o pacote não entra na fila.

## Modos de operação

| Modo | Comportamento |
|---|---|
| `MANUAL` | Nada é preparado sem sua ação |
| `ASSISTED` | Prepara as que passam dos limiares; você revisa antes do envio |
| `AUTOMATIC` | Prepara e enfileira dentro das regras configuradas |

E, ortogonalmente, a revisão:

| Modo | Quando exige revisão |
|---|---|
| `ALWAYS_REVIEW` | Sempre |
| `REVIEW_FLAGGED` | Requisito crítico em aberto, destinatário incomum, score na fronteira do limiar, período indeterminado, escolha de currículo sem correspondência clara |
| `FULLY_AUTOMATIC` | Nunca |

## Prioridade 2027

A fila **não** é ordenada só por score. A janela de contratação é o critério
primário; o score decide dentro da faixa.

| Situação | Classe | Prioridade | Peso |
|---|---|---|---|
| Começa em 2027 | `TARGET_2027` | VERY_HIGH | 100 |
| Começa no fim de 2026 e entra em 2027 | `TARGET_2027` | HIGH | 75 |
| Sobrepõe 2027 | `TARGET_2027` | HIGH | 75 |
| Encerra antes de 2027 | `CURRENT_2026` | NORMAL | 45 |
| Data desconhecida | `UNKNOWN_DATE` | UNKNOWN | 30 |
| Posterior a 2027 | `FUTURE_AFTER_2027` | LOW | 20 |

Data desconhecida pesa **mais** que período claramente ruim: não saber não pode
ser punido como saber que é ruim. E o período nunca é inventado — sem data
extraível, o rótulo é "Período não disponível".

O ano-alvo é configurável, os pesos são configuráveis, e existe um modo
`weighted` em que o mérito puro pode superar a janela. Toda posição da fila vem
com explicação legível:

```
#1  Agricultural Equipment Operator   Prioridade 2027   prio=66.3
    O período de trabalho começa em 2027 (01/2027 – 10/2027), exatamente a
    janela de contratação priorizada. Opportunity 71, Fit 24, ATS —.
```

## Retry

| Erro | Classe | Ação |
|---|---|---|
| Timeout, 429, 5xx, rede | TRANSIENT | Backoff 5min → 30min → 2h, depois FAILED |
| Destinatário inválido, 550 | PERMANENT | FAILED imediato |
| Autorização revogada | PERMANENT | FAILED + marca o Gmail como expirado |
| Anexo ausente | PERMANENT | FAILED imediato |

Excedente de cota permanece `QUEUED` — nunca é descartado — e é revalidado
(duplicata, anexos) antes de cada tentativa.

## Carta de apresentação × carta de recomendação

Distinção inegociável (spec §36):

- **Carta de apresentação** é gerada pelo sistema, usando apenas fatos do Perfil
  Mestre. Cada bloco só entra se o dado existir: sem anos de experiência
  declarados, a frase sobre experiência não aparece.
- **Carta de recomendação** representa o endosso de outra pessoa. **Nunca** é
  gerada. Só entra como documento enviado pelo usuário, com
  `doc_type = 'recommendation_letter'`.

## Gmail

OAuth 2.0, escopo `gmail.send`. **A senha do Gmail nunca é solicitada nem
armazenada**, e o caminho de "senha de aplicativo" da v1 foi removido. Os tokens
ficam em `private_uploads/.secrets/` com permissão 0600, fora de qualquer
diretório servido, e nunca aparecem em log.

Sem `GOOGLE_CLIENT_ID` e `GOOGLE_CLIENT_SECRET` configurados, o envio fica
indisponível e a interface diz exatamente isso — não há caminho alternativo
silencioso.
