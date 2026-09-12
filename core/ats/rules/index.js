/**
 * Pacotes de regras ATS versionados (spec §8, §9, §10, §55).
 *
 * Arquitetura: regras-base por país + extensões por plataforma.
 *
 *   ATSRuleEngine
 *     ├── BrazilATSRules ── GupyBrazilRules, IndeedBrazilRules
 *     └── USAATSRules ──── GupyUsaRules, IndeedUsaRules, SeasonalUsaRules
 *
 * As regras são DADOS. A detecção fica no formatAnalyzer, que produz "signals";
 * cada regra apenas declara sob quais signals ela dispara. Isso mantém as regras
 * testáveis e permite versioná-las sem tocar na lógica de análise.
 *
 * IMPORTANTE (spec §7): nada aqui prevê aprovação ou probabilidade de contratação.
 * São heurísticas transparentes de COMPATIBILIDADE de leitura e aderência.
 */

const SEVERITY = { CRITICAL: 'CRITICAL', HIGH: 'HIGH', MEDIUM: 'MEDIUM', LOW: 'LOW' };

// ---------------------------------------------------------------------------
// BASE — BRASIL  (spec §9)
// ---------------------------------------------------------------------------

const brazilBase = {
  id: 'br-general-v1',
  country: 'BR',
  platform: null,
  label: 'Brasil — regras gerais',
  language: 'pt-BR',

  // §18 — dimensões do ATS Score
  weights: {
    resume_parsing_quality: 0.22,
    keyword_coverage:       0.20,
    experience_alignment:   0.18,
    skills_alignment:       0.14,
    section_structure:      0.12,
    country_convention:     0.06,
    platform_readability:   0.04,
    content_completeness:   0.04
  },

  sections: {
    required: ['experiencia', 'formacao', 'competencias'],
    recommended: ['objetivo', 'certificacoes', 'idiomas'],
    aliases: {
      objetivo:      ['objetivo', 'objetivo profissional', 'resumo', 'perfil', 'resumo profissional', 'sobre'],
      experiencia:   ['experiencia', 'experiencia profissional', 'experiencias', 'historico profissional', 'atuacao profissional'],
      formacao:      ['formacao', 'formacao academica', 'escolaridade', 'educacao'],
      competencias:  ['competencias', 'habilidades', 'conhecimentos', 'skills', 'competencias tecnicas'],
      certificacoes: ['certificacoes', 'cursos', 'cursos complementares', 'certificados', 'qualificacoes'],
      idiomas:       ['idiomas', 'linguas'],
      projetos:      ['projetos', 'portfolio']
    }
  },

  format: {
    maxColumns: 1,
    maxPages: 3,
    allowPhoto: true,            // aceito no Brasil, mas penalizado em importação automática
    allowTables: false,
    allowTextBoxes: false,
    allowHeaderFooterContact: false
  },

  conventions: [
    {
      id: 'br-multi-column',
      when: s => s.columns >= 2,
      severity: SEVERITY.HIGH,
      title: 'Layout em múltiplas colunas',
      why: 'A extração automática costuma ler o documento da esquerda para a direita, linha a linha, e embaralha o conteúdo de colunas paralelas. Sua experiência pode chegar ao recrutador fora de ordem.',
      correction: 'Use uma única coluna contínua, com as experiências empilhadas verticalmente.'
    },
    {
      id: 'br-tables',
      when: s => s.hasTables,
      severity: SEVERITY.HIGH,
      title: 'Conteúdo dentro de tabelas',
      why: 'Tabelas viram sequências de células na extração. Datas, cargos e empresas podem se separar do contexto a que pertencem.',
      correction: 'Substitua tabelas por listas ou parágrafos simples.'
    },
    {
      id: 'br-textboxes',
      when: s => s.hasTextBoxes,
      severity: SEVERITY.CRITICAL,
      title: 'Texto dentro de caixas de texto',
      why: 'Caixas de texto frequentemente são ignoradas por completo na extração — o conteúdo delas some.',
      correction: 'Mova o texto das caixas para o corpo do documento.'
    },
    {
      id: 'br-images',
      when: s => s.hasImages,
      severity: SEVERITY.MEDIUM,
      title: 'Imagens no currículo',
      why: 'Segundo a orientação pública da Gupy a candidatos, imagens podem interferir na importação automática dos dados. Nada que esteja apenas dentro de uma imagem é lido.',
      correction: 'Remova imagens decorativas e garanta que nenhuma informação exista somente em formato de imagem.'
    },
    {
      id: 'br-photo',
      when: s => s.photoLikely,
      severity: SEVERITY.LOW,
      title: 'Foto no currículo',
      why: 'A foto é culturalmente aceita no Brasil, mas ocupa espaço útil e é um dos elementos que mais atrapalha a importação automática.',
      correction: 'Considere uma versão sem foto especificamente para candidaturas via plataforma.'
    },
    {
      id: 'br-header-footer-contact',
      when: s => s.headerFooterContact,
      severity: SEVERITY.HIGH,
      title: 'Contato apenas no cabeçalho ou rodapé',
      why: 'Cabeçalhos e rodapés de PDF/DOCX costumam ficar fora do fluxo principal de texto e podem não ser extraídos.',
      correction: 'Repita e-mail e telefone no corpo do documento, logo abaixo do nome.'
    },
    {
      id: 'br-missing-sections',
      when: s => s.missingRequiredSections.length > 0,
      severity: SEVERITY.HIGH,
      title: 'Seções obrigatórias ausentes ou com título não reconhecido',
      why: 'A extração identifica blocos pelo título da seção. Títulos criativos ("Minha jornada") não são reconhecidos e o bloco inteiro pode ficar sem classificação.',
      correction: 'Use títulos convencionais: Experiência Profissional, Formação Acadêmica, Competências.'
    },
    {
      id: 'br-no-dates',
      when: s => s.dateConsistency.entriesWithDates === 0 && s.dateConsistency.experienceEntries > 0,
      severity: SEVERITY.HIGH,
      title: 'Experiências sem datas identificáveis',
      why: 'Sem datas de início e fim não é possível calcular tempo de experiência, que costuma ser um critério objetivo de triagem.',
      correction: 'Use o formato mm/aaaa – mm/aaaa em cada experiência (ou "atual" para a vigente).'
    },
    {
      id: 'br-inconsistent-dates',
      when: s => s.dateConsistency.formats.length > 1,
      severity: SEVERITY.LOW,
      title: 'Formatos de data inconsistentes',
      why: 'Misturar formatos ("2023", "03/2023", "Mar 2023") reduz a confiabilidade da leitura automática das datas.',
      correction: 'Padronize todas as datas em um único formato, preferencialmente mm/aaaa.'
    },
    {
      id: 'br-no-contact-email',
      when: s => !s.contactInfo.email,
      severity: SEVERITY.CRITICAL,
      title: 'E-mail não encontrado no texto',
      why: 'Sem e-mail extraível o cadastro fica incompleto e o contato pode não acontecer.',
      correction: 'Escreva o e-mail em texto simples, sem ícone e sem estar apenas como hyperlink.'
    },
    {
      id: 'br-too-long',
      when: s => s.pageCount > 3,
      severity: SEVERITY.MEDIUM,
      title: 'Currículo com mais de 3 páginas',
      why: 'Documentos longos diluem os termos relevantes e reduzem a densidade de aderência à vaga.',
      correction: 'Concentre em 2 páginas, priorizando as experiências dos últimos 10 anos.'
    },
    {
      id: 'br-low-bullets',
      when: s => s.bulletStructure.ratio < 0.15 && s.wordCount > 250,
      severity: SEVERITY.LOW,
      title: 'Pouca estrutura em tópicos',
      why: 'Blocos longos de texto corrido dificultam tanto a leitura humana quanto a segmentação automática das atividades.',
      correction: 'Descreva as atividades em tópicos curtos, um por linha.'
    }
  ]
};

// ---------------------------------------------------------------------------
// BASE — ESTADOS UNIDOS  (spec §10)
// ---------------------------------------------------------------------------

const usaBase = {
  id: 'us-general-v1',
  country: 'US',
  platform: null,
  label: 'Estados Unidos — regras gerais',
  language: 'en-US',

  weights: {
    resume_parsing_quality: 0.20,
    keyword_coverage:       0.22,
    experience_alignment:   0.18,
    skills_alignment:       0.13,
    section_structure:      0.11,
    country_convention:     0.10,
    platform_readability:   0.03,
    content_completeness:   0.03
  },

  sections: {
    required: ['experience', 'education', 'skills'],
    recommended: ['summary', 'certifications'],
    aliases: {
      summary:        ['summary', 'professional summary', 'profile', 'objective', 'about'],
      experience:     ['experience', 'work experience', 'professional experience', 'employment history', 'work history'],
      education:      ['education', 'academic background'],
      skills:         ['skills', 'technical skills', 'core competencies', 'competencies', 'areas of expertise'],
      certifications: ['certifications', 'licenses', 'licenses & certifications', 'credentials'],
      projects:       ['projects', 'selected projects']
    }
  },

  format: {
    maxColumns: 1,
    maxPages: 2,
    allowPhoto: false,           // convenção US: foto não é usada
    allowTables: false,
    allowTextBoxes: false,
    allowHeaderFooterContact: false
  },

  conventions: [
    {
      id: 'us-multi-column',
      when: s => s.columns >= 2,
      severity: SEVERITY.HIGH,
      title: 'Two-column layout',
      why: 'A extração automática lê linha a linha e pode intercalar o conteúdo das duas colunas, entregando a experiência fora de ordem.',
      correction: 'Use uma coluna contínua, com as experiências empilhadas verticalmente.'
    },
    {
      id: 'us-tables',
      when: s => s.hasTables,
      severity: SEVERITY.HIGH,
      title: 'Conteúdo em tabelas',
      why: 'Células de tabela são extraídas isoladamente e perdem a relação entre cargo, empresa e período.',
      correction: 'Converta tabelas em listas simples.'
    },
    {
      id: 'us-textboxes',
      when: s => s.hasTextBoxes,
      severity: SEVERITY.CRITICAL,
      title: 'Texto em caixas de texto',
      why: 'Caixas de texto costumam ser ignoradas integralmente na extração.',
      correction: 'Mova esse conteúdo para o corpo do documento.'
    },
    {
      id: 'us-photo',
      when: s => s.photoLikely,
      severity: SEVERITY.HIGH,
      title: 'Foto no currículo (convenção US)',
      why: 'Currículos nos EUA convencionalmente não trazem foto. Muitos empregadores removem ou descartam currículos com foto por política interna de triagem às cegas. Isto é uma convenção de mercado, não uma regra legal universal.',
      correction: 'Remova a foto da versão destinada a vagas nos EUA.'
    },
    {
      id: 'us-personal-details',
      when: s => s.personalDetails.length > 0,
      severity: SEVERITY.MEDIUM,
      title: 'Dados pessoais desnecessários',
      why: 'Estado civil, data de nascimento, CPF/RG e nacionalidade não são usados em currículos nos EUA e ocupam espaço que deveria ser de conteúdo relevante. Isto é convenção de mercado, não exigência legal.',
      correction: 'Remova esses campos da versão US.',
      evidenceFrom: s => s.personalDetails
    },
    {
      id: 'us-header-footer-contact',
      when: s => s.headerFooterContact,
      severity: SEVERITY.HIGH,
      title: 'Contato apenas no cabeçalho ou rodapé',
      why: 'Cabeçalho e rodapé podem ficar fora do fluxo de texto extraído.',
      correction: 'Repita e-mail e telefone no corpo do documento.'
    },
    {
      id: 'us-missing-sections',
      when: s => s.missingRequiredSections.length > 0,
      severity: SEVERITY.HIGH,
      title: 'Seções padrão ausentes',
      why: 'Títulos não convencionais impedem a classificação correta dos blocos do currículo.',
      correction: 'Use os títulos padrão: Experience, Education, Skills.'
    },
    {
      id: 'us-no-achievements',
      when: s => s.achievementSignals.quantified === 0 && s.bulletStructure.count > 3,
      severity: SEVERITY.MEDIUM,
      title: 'Conquistas sem métricas',
      why: 'A convenção US valoriza bullets orientados a resultado com números. Só inclua métricas que sejam verdadeiras e verificáveis no seu histórico.',
      correction: 'Onde houver resultado real e mensurável, inclua o número (%, volume, valor, prazo).'
    },
    {
      id: 'us-weak-verbs',
      when: s => s.achievementSignals.actionVerbRatio < 0.3 && s.bulletStructure.count > 3,
      severity: SEVERITY.LOW,
      title: 'Poucos verbos de ação no início dos tópicos',
      why: 'A convenção US espera bullets iniciados por verbo de ação no passado (Led, Built, Reduced).',
      correction: 'Reescreva os tópicos começando por um verbo de ação.'
    },
    {
      id: 'us-no-contact-email',
      when: s => !s.contactInfo.email,
      severity: SEVERITY.CRITICAL,
      title: 'E-mail não encontrado no texto',
      why: 'Sem e-mail extraível o candidato pode não ser contatado.',
      correction: 'Inclua o e-mail em texto simples.'
    },
    {
      id: 'us-too-long',
      when: s => s.pageCount > 2,
      severity: SEVERITY.MEDIUM,
      title: 'Mais de 2 páginas',
      why: 'A convenção US para a maioria dos perfis é 1–2 páginas. Documentos longos diluem os termos relevantes.',
      correction: 'Reduza para no máximo 2 páginas.'
    },
    {
      id: 'us-skill-charts',
      when: s => s.hasSkillCharts,
      severity: SEVERITY.MEDIUM,
      title: 'Barras ou gráficos de nível de habilidade',
      why: 'Gráficos de proficiência não carregam texto extraível — a habilidade em si não é lida, só o nome dela, sem contexto.',
      correction: 'Substitua por texto: "Google Ads — 5 anos, gestão de campanhas de aquisição".'
    }
  ]
};

// ---------------------------------------------------------------------------
// EXTENSÕES POR PLATAFORMA
// ---------------------------------------------------------------------------

const gupyBrazil = {
  id: 'br-gupy-v1',
  extends: 'br-general-v1',
  country: 'BR',
  platform: 'gupy',
  label: 'Gupy Brasil',
  weightOverrides: {
    resume_parsing_quality: 0.26,
    platform_readability:   0.08,
    country_convention:     0.02
  },
  conventions: [
    {
      id: 'gupy-br-single-column',
      when: s => s.columns >= 2,
      severity: SEVERITY.CRITICAL,
      title: 'Coluna única é especialmente importante na Gupy',
      why: 'A orientação pública da Gupy a candidatos recomenda currículos em uma coluna justamente porque a importação automática preenche o perfil a partir do texto extraído. Em duas colunas, campos do perfil podem ser preenchidos com o conteúdo errado.',
      correction: 'Envie uma versão em coluna única para candidaturas na Gupy.'
    },
    {
      id: 'gupy-br-profile-completeness',
      when: s => s.contactInfo.filled < 3,
      severity: SEVERITY.HIGH,
      title: 'Informações de perfil incompletas para importação',
      why: 'A Gupy monta o perfil do candidato a partir do currículo importado. Campos ausentes viram lacunas no perfil que o recrutador vê.',
      correction: 'Garanta nome, e-mail, telefone e cidade/estado em texto simples no topo do documento.'
    },
    {
      id: 'gupy-br-decoration',
      when: s => s.hasImages || s.hasSkillCharts,
      severity: SEVERITY.MEDIUM,
      title: 'Decoração acima de conteúdo',
      why: 'A orientação da Gupy é explícita: o conteúdo pesa mais que a apresentação visual, e elementos gráficos atrapalham a leitura automática.',
      correction: 'Priorize texto estruturado; remova elementos puramente decorativos.'
    }
  ]
};

const gupyUsa = {
  id: 'us-gupy-v1',
  extends: 'us-general-v1',
  country: 'US',
  platform: 'gupy',
  label: 'Gupy USA',
  weightOverrides: { resume_parsing_quality: 0.24, platform_readability: 0.06 },
  conventions: [
    {
      id: 'gupy-us-english-consistency',
      when: s => s.languageMix.mixed,
      severity: SEVERITY.HIGH,
      title: 'Currículo mistura português e inglês',
      why: 'Para vagas nos EUA o documento deve estar integralmente em inglês. A mistura reduz a aderência aos termos da vaga e sinaliza descuido.',
      correction: 'Mantenha uma versão exclusivamente em inglês para vagas US.',
      evidenceFrom: s => s.languageMix.samples
    }
  ]
};

const indeedBrazil = {
  id: 'br-indeed-v1',
  extends: 'br-general-v1',
  country: 'BR',
  platform: 'indeed',
  label: 'Indeed Brasil',
  weightOverrides: { keyword_coverage: 0.24, resume_parsing_quality: 0.20 },
  conventions: [
    {
      id: 'indeed-br-title-alignment',
      when: s => s.titleAlignment && s.titleAlignment.aligned === false,
      severity: SEVERITY.MEDIUM,
      title: 'Título profissional distante do título da vaga',
      why: 'Buscas em agregadores dão peso ao título declarado. Um título muito distante do da vaga reduz a recuperação do currículo.',
      correction: 'Aproxime o título do topo do currículo da nomenclatura usada na vaga, desde que seja verdadeiro para sua atuação.'
    }
  ]
};

const indeedUsa = {
  id: 'us-indeed-v1',
  extends: 'us-general-v1',
  country: 'US',
  platform: 'indeed',
  label: 'Indeed USA',
  weightOverrides: { keyword_coverage: 0.25, country_convention: 0.10 },
  conventions: [
    {
      id: 'indeed-us-title-alignment',
      when: s => s.titleAlignment && s.titleAlignment.aligned === false,
      severity: SEVERITY.MEDIUM,
      title: 'Job title distante do título da vaga',
      why: 'Agregadores dão peso ao título declarado no topo do currículo para recuperação em busca.',
      correction: 'Use uma nomenclatura de cargo reconhecida no mercado US e próxima à da vaga, se for verdadeira para você.'
    },
    {
      id: 'indeed-us-work-authorization',
      when: s => s.workAuthorization.mentioned === false,
      severity: SEVERITY.LOW,
      title: 'Situação de autorização de trabalho não mencionada',
      why: 'Muitas vagas US filtram por autorização de trabalho. A ausência da informação deixa o critério em aberto — e o sistema não pode presumir sua situação.',
      correction: 'Se e somente se for verdade, declare sua situação real. Não invente status de visto.'
    }
  ]
};

const seasonalUsa = {
  id: 'us-seasonal-v1',
  extends: 'us-general-v1',
  country: 'US',
  platform: 'seasonal',
  label: 'Seasonal Jobs (H-2A / H-2B)',
  weightOverrides: {
    experience_alignment:   0.24,
    keyword_coverage:       0.18,
    country_convention:     0.06,
    resume_parsing_quality: 0.16,
    content_completeness:   0.08
  },
  conventions: [
    {
      id: 'seasonal-availability',
      when: s => s.availability.mentioned === false,
      severity: SEVERITY.HIGH,
      title: 'Período de disponibilidade não declarado',
      why: 'Vagas sazonais são definidas por um período de contrato. Sem disponibilidade declarada, o empregador não consegue avaliar o encaixe no calendário da safra.',
      correction: 'Declare o período em que está disponível (mês/ano de início e fim).'
    },
    {
      id: 'seasonal-license',
      when: s => s.licenseSignals.required && !s.licenseSignals.present,
      severity: SEVERITY.HIGH,
      title: 'Habilitação/licença não evidenciada',
      why: 'Boa parte das ordens de serviço H-2A exige carteira de habilitação válida como requisito obrigatório.',
      correction: 'Descreva a habilitação real que possui, com categoria e situação. Não declare CDL americana se você não a possui.'
    },
    {
      id: 'seasonal-physical',
      when: s => s.physicalSignals.mentioned === false,
      severity: SEVERITY.LOW,
      title: 'Capacidade física e condições de trabalho não mencionadas',
      why: 'Ordens H-2A costumam listar requisitos físicos explícitos (levantar peso, trabalho externo, jornada estendida).',
      correction: 'Mencione, se for verdade, a experiência com trabalho físico externo e jornadas longas.'
    },
    {
      id: 'seasonal-simple-language',
      when: s => s.readability.avgSentenceWords > 28,
      severity: SEVERITY.LOW,
      title: 'Frases longas demais',
      why: 'A leitura desses currículos costuma ser feita por equipes pequenas de fazendas e escritórios de imigração, em triagem rápida.',
      correction: 'Use frases curtas e diretas, em inglês simples.'
    }
  ]
};

// ---------------------------------------------------------------------------
// REGISTRO
// ---------------------------------------------------------------------------

const BASES = { 'br-general-v1': brazilBase, 'us-general-v1': usaBase };

const EXTENSIONS = {
  'br-gupy-v1':    gupyBrazil,
  'us-gupy-v1':    gupyUsa,
  'br-indeed-v1':  indeedBrazil,
  'us-indeed-v1':  indeedUsa,
  'us-seasonal-v1': seasonalUsa
};

const ALL_RULE_SET_IDS = Object.keys(BASES).concat(Object.keys(EXTENSIONS));

module.exports = { SEVERITY, BASES, EXTENSIONS, ALL_RULE_SET_IDS };
