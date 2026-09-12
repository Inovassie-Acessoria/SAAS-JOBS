# Isolamento por plataforma e país

## O invariante

> Toda plataforma é dona do próprio perfil, currículos, preferências, contexto
> de ATS e histórico. Nenhuma plataforma consome automaticamente dados de
> candidato de outra.

Qualquer implementação que viole isso é arquiteturalmente incorreta (spec §1K).

**Isto reverte a decisão anterior.** A versão 2 tinha um Perfil Mestre e uma
Biblioteca de Currículos compartilhada. O spec de infraestrutura §1A tornou os
dois proibidos, e a migração v3 os removeu.

## Os cinco ambientes

```
gupy/BR      perfil + currículos + análises ATS próprios
gupy/US      idem, independente do BR
indeed/BR    idem
indeed/US    idem
seasonal/US  idem — o produto é US-only, não há seasonal/BR
```

Cinco perfis separados. Cinco conjuntos de currículos separados. Nenhuma cópia
automática entre eles.

## O que isso significa na prática

| Situação | Comportamento |
|---|---|
| Atualizar o perfil do Gupy BR | Nada acontece nos outros quatro ambientes |
| Enviar um currículo no Indeed US | Ele não aparece no Gupy nem no Seasonal |
| Seasonal precisa de currículo e não tem | Diz "nenhum currículo configurado para seasonal/US" — **não** usa o do Indeed |
| Analisar ATS no Gupy BR | Usa perfil BR + currículo BR + regra `br-gupy-v1` |
| Pedir um currículo do Gupy pela rota do Indeed | 404 |

## Onde fica no banco

```
gupy_profiles(country)          UNIQUE(country)
gupy_resumes(country, …)
gupy_resume_analysis

indeed_profiles(country)        UNIQUE(country)
indeed_resumes(country, …)
indeed_resume_analysis

seasonal_profiles(country='US') UNIQUE(country)
seasonal_resumes(…)
seasonal_resume_analysis
```

O que permanece em `core_` é **infraestrutura**, nunca dado de candidato:

```
core_system_settings      configuração da aplicação
core_audit_logs           auditoria
core_ats_rule_sets        registro dos pacotes de regras
core_integration_status   saúde dos provedores
core_unassigned_documents documentos herdados aguardando atribuição
```

## Chaves de armazenamento

Mesmo com todos os arquivos no mesmo bucket, a chave declara o dono (§1H):

```
users/{user_id}/gupy/br/resumes/{id}.pdf
users/{user_id}/gupy/us/resumes/{id}.pdf
users/{user_id}/indeed/br/resumes/{id}.pdf
users/{user_id}/indeed/us/resumes/{id}.pdf
users/{user_id}/seasonal/us/resumes/{id}.pdf
```

## Rotas

Toda operação de candidato declara o ambiente no endereço:

```
GET  /api/env/:platform/:country/profile
PUT  /api/env/:platform/:country/profile
GET  /api/env/:platform/:country/resumes
POST /api/env/:platform/:country/resumes
GET  /api/env/:platform/:country/resumes/:id/file
GET  /api/env/:platform/:country/ats/center
POST /api/env/:platform/:country/ats/analyze/:resumeId
POST /api/env/:platform/:country/ats/compare
```

Não existe `/api/core/profile` nem `/api/core/resumes`. A ausência é deliberada.

## A migração v3

O spec §1J define como migrar sem perder dados:

1. os documentos da biblioteca compartilhada foram para `core_unassigned_documents`;
2. **nada foi atribuído automaticamente** — atribuir a todos os ambientes
   recriaria o compartilhamento que a migração existe para eliminar;
3. o usuário escolhe o destino de cada documento, e a atribuição cria uma
   **cópia independente**;
4. o registro original permanece, marcado com o destino;
5. depois de copiado, os dois são independentes: renomear a cópia não altera
   o original.

O perfil mestre antigo semeou **apenas** o ambiente do país que ele declarava.
Presumir que o mesmo perfil serve aos cinco seria a sincronização que o §1D proíbe.

## O que é permitido compartilhar

Infraestrutura técnica, explicitamente (§1G):

- autenticação e usuários;
- design system e componentes;
- motores de ATS, matching e linha do tempo (`core/`) — são **algoritmos**, e
  recebem o contexto do ambiente como parâmetro;
- logging, banco, storage.

O que nunca é compartilhado é **dado de negócio do candidato**.

## Cobertura de teste

`tests/environment-isolation.test.js` — 14 testes verificando o invariante:
tabelas proibidas ausentes, perfis independentes, ausência de propagação,
separação BR × US, currículos presos ao ambiente, chave de armazenamento,
recomendação sem fallback, ATS escopado, e o fluxo de atribuição explícita.
