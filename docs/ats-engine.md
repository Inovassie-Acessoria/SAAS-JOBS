# Motor ATS

## O aviso que vem antes de tudo

**Não existe um algoritmo de ATS único usado por todos os empregadores.** O que este
motor produz é uma heurística transparente de compatibilidade de leitura e aderência.
Ele não prevê aprovação, não estima probabilidade de contratação e não afirma que um
currículo "vai passar" (spec §7).

Toda saída carrega esse aviso, e há teste verificando que nenhuma mensagem promete
aprovação.

## Regras por país e plataforma

```
BrazilATSRules (br-general-v1)          USAATSRules (us-general-v1)
  ├── GupyBrazilRules  (br-gupy-v1)       ├── GupyUsaRules     (us-gupy-v1)
  └── IndeedBrazilRules(br-indeed-v1)     ├── IndeedUsaRules   (us-indeed-v1)
                                          └── SeasonalUsaRules (us-seasonal-v1)
```

A extensão herda a base e sobrescreve pesos e regras. Os pesos são renormalizados
para somar 1 depois dos overrides — verificado em teste.

### Onde Brasil e EUA divergem de fato

| | Brasil | EUA |
|---|---|---|
| Foto | Aceita (penalidade baixa, por atrapalhar importação) | Contra a convenção (penalidade alta) |
| Páginas | Até 3 | Até 2 |
| Dados pessoais | Comuns | Sinalizados como desnecessários |
| Conquistas com métrica | Não cobrado | Cobrado |
| Seções | Experiência, Formação, Competências | Experience, Education, Skills |

As regras da Gupy Brasil refletem a orientação pública da própria Gupy a candidatos:
coluna única, conteúdo acima de decoração, e imagens atrapalhando a importação automática.

## Componentes da pontuação

```
resume_parsing_quality    leitura do arquivo: colunas, tabelas, caixas de texto
keyword_coverage          conceitos da vaga presentes no currículo (via ontologia)
experience_alignment      requisitos com lastro no texto do currículo
skills_alignment          habilidades do perfil evidenciadas no documento
section_structure         seções obrigatórias reconhecíveis
country_convention        convenções do mercado
platform_readability      particularidades da plataforma
content_completeness      contato, datas, volume mínimo
```

Componentes que não podem ser avaliados (por exemplo, cobertura de termos sem uma
vaga de referência) são **excluídos e os pesos renormalizados** — nunca contam como zero.

## Formato das issues

Cada problema detectado traz o conjunto completo que a §12 exige:

```
Issue             título curto
Severidade        CRITICAL | HIGH | MEDIUM | LOW
Por que importa   consequência concreta na extração
Evidência         o que foi observado no documento
Correção          ação específica
Regra             país, plataforma e versão do pacote
```

## Sugestões de reescrita

O sistema sugere, o usuário decide, e o arquivo original nunca é sobrescrito (§69).

Toda sugestão se ancora num fato do Perfil Mestre:

- **REWRITE** — a vaga cita um conceito que o perfil sustenta, mas que não aparece
  no currículo. A sugestão cita explicitamente qual experiência a fundamenta.
- **GAP** — a vaga cita algo que o perfil **não** sustenta. Aqui a recomendação é
  *não incluir*, e registrar primeiro no Perfil Mestre se for verdade.

Não existe caminho no código que sugira afirmar experiência sem lastro. Há teste
verificando isso.

## Equivalência semântica

A comparação não é por palavra-chave literal. A ontologia em
`core/match/skillOntology.js` agrupa conceitos equivalentes e liga grupos adjacentes,
sempre com confiança declarada:

| Comparação | Tipo | Confiança | Peso de cobertura |
|---|---|---|---|
| Google Ads ↔ Google Ads | EXACT | — | 1,00 |
| Performance Marketing ↔ Paid Media | SEMANTIC | HIGH | 0,95 |
| Power BI ↔ SQL | SEMANTIC | MEDIUM | 0,65 |
| grupos distantes | SEMANTIC | LOW | 0,35 |
| sem relação | NONE | — | 0,00 |

Confiança baixa **não** conta como requisito plenamente atendido (spec §53).

## Classificação de requisitos

| Classe | Como é detectada | Efeito de não atender |
|---|---|---|
| `MANDATORY` | "required", "must have", "obrigatório", ou um gate (habilitação, autorização de trabalho) | Limita a prioridade |
| `CONTEXTUAL` | "5+ anos", "mínimo de 3" | Permite "quase atendido" |
| `PREFERRED` | "desejável", "diferencial", "nice to have" | Pouco impacto |
| `AMBIGUOUS` | Sem marcador reconhecível | Sinalizado para leitura humana |

Um requisito de 5 anos com 4,7 no perfil resulta em `NEAR` — revisão contextual,
não reprovação. Um requisito crítico **sem informação** resulta em `UNRESOLVED`:
o sistema não presume nem a favor nem contra.

## Extração de texto

PDF e DOCX são lidos sem dependência externa, usando apenas `zlib`:

- **PDF** — percorre os content streams, infla os FlateDecode, extrai os operadores
  `Tj`/`TJ`. PDFs digitalizados ou com codificação de fonte customizada resultam em
  `confidence: LOW`, e a análise inteira é rebaixada para `RISKY` com aviso explícito.
- **DOCX** — lê o ZIP manualmente, infla `word/document.xml`, e detecta colunas,
  tabelas, caixas de texto e imagens direto da marcação.

Confiança baixa nunca é escondida: aparece na Biblioteca, no ATS Center e na análise.
