/**
 * ATS Format Analyzer (spec §11).
 *
 * Recebe o resultado da extração de texto e produz os "signals" que os pacotes
 * de regras consomem. Toda detecção é heurística sobre o texto extraído — por
 * isso cada sinal relevante carrega evidência, e o analisador nunca afirma algo
 * que não conseguiu observar (spec §7, §54).
 */

const SECTION_STOPWORDS = /^[\s\-–—•*·]+|[\s:：]+$/g;

const ACTION_VERBS = [
  'led', 'built', 'managed', 'reduced', 'increased', 'launched', 'designed', 'developed',
  'implemented', 'created', 'improved', 'delivered', 'negotiated', 'coordinated', 'operated',
  'maintained', 'trained', 'supervised', 'optimized', 'automated', 'drove', 'owned', 'scaled',
  'liderei', 'gerenciei', 'implementei', 'desenvolvi', 'criei', 'reduzi', 'aumentei',
  'entreguei', 'coordenei', 'operei', 'mantive', 'treinei', 'otimizei', 'automatizei'
];

const PERSONAL_DETAIL_PATTERNS = [
  { id: 'marital_status', re: /\b(estado civil|marital status|casad[oa]|solteir[oa]|married|single)\b/i, label: 'Estado civil' },
  { id: 'birth_date',     re: /\b(data de nascimento|date of birth|nascid[oa] em|\bDOB\b)\b/i,          label: 'Data de nascimento' },
  { id: 'national_id',    re: /\b(CPF|RG|CNH n[ºo]|SSN|social security)\b/i,                            label: 'Documento de identidade' },
  { id: 'nationality',    re: /\b(nacionalidade|nationality)\b/i,                                       label: 'Nacionalidade' },
  { id: 'gender',         re: /\b(sexo|g[êe]nero|gender)\s*:/i,                                         label: 'Gênero' },
  { id: 'age',            re: /\b(idade|age)\s*:\s*\d{2}\b/i,                                           label: 'Idade' }
];

const PT_MARKERS = /\b(experiência|formação|competências|habilidades|empresa|cargo|atualmente|responsável|desenvolvimento|gestão|realizações)\b/gi;
const EN_MARKERS = /\b(experience|education|skills|company|position|currently|responsible|development|management|achievements)\b/gi;

const DATE_FORMATS = [
  { id: 'mm/yyyy',   re: /\b(0?[1-9]|1[0-2])\/(19|20)\d{2}\b/g },
  { id: 'mon yyyy',  re: /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|fev|abr|mai|ago|set|out|dez)[a-zç]*\.?\s+(19|20)\d{2}\b/gi },
  { id: 'yyyy only', re: /(?<![\/\-\w])(19|20)\d{2}(?![\/\-\w])/g },
  { id: 'dd/mm/yyyy', re: /\b(0?[1-9]|[12]\d|3[01])\/(0?[1-9]|1[0-2])\/(19|20)\d{2}\b/g }
];

function stripAccents(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function normalizeHeading(line) {
  return stripAccents(line.toLowerCase()).replace(SECTION_STOPWORDS, '').trim();
}

/**
 * Detecta layout em colunas a partir do texto extraído.
 * Sinal: muitas linhas contendo um "vão" interno de 3+ espaços, o que costuma
 * indicar duas colunas lidas lado a lado pelo extrator.
 */
function detectColumns(text, meta) {
  if (meta && meta.hasColumns) return { columns: 2, evidence: 'Documento declara múltiplas colunas na configuração de seção.' };

  const lines = text.split('\n').filter(l => l.trim().length > 20);
  if (lines.length < 8) return { columns: 1, evidence: null };

  let gapLines = 0;
  const samples = [];
  for (const line of lines) {
    const gap = /\S {3,}\S/.test(line);
    if (gap) {
      gapLines++;
      if (samples.length < 3) samples.push(line.trim().slice(0, 90));
    }
  }

  const ratio = gapLines / lines.length;
  if (ratio > 0.35) {
    return {
      columns: 2,
      evidence: `${gapLines} de ${lines.length} linhas contêm vãos internos largos, padrão típico de duas colunas. Ex.: "${samples[0] || ''}"`
    };
  }
  return { columns: 1, evidence: null };
}

function detectTables(text, meta) {
  if (meta && meta.hasTables) return true;
  const lines = text.split('\n');
  // Linhas com 2+ separadores de coluna repetidos
  const pipeLines = lines.filter(l => (l.match(/\|/g) || []).length >= 2).length;
  return pipeLines >= 3;
}

function detectContactInfo(text) {
  const email = (text.match(/[\w.+-]+@[\w-]+\.[\w.]{2,}/) || [null])[0];
  const phone = (text.match(/(\+?\d{1,3}[\s.-]?)?\(?\d{2,4}\)?[\s.-]?\d{3,5}[\s.-]?\d{3,4}/) || [null])[0];
  const linkedin = (text.match(/linkedin\.com\/[\w\-\/]+/i) || [null])[0];
  const location = (text.match(/\b([A-ZÁÉÍÓÚÂÊÔÃÕÇ][a-záéíóúâêôãõç]+(?:\s[A-ZÁÉÍÓÚÂÊÔÃÕÇ][a-záéíóúâêôãõç]+)*)\s*[,\-–]\s*([A-Z]{2})\b/) || [null])[0];

  const filled = [email, phone, location, linkedin].filter(Boolean).length;
  return { email, phone, linkedin, location, filled };
}

function detectSections(text, aliases, required) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const found = {};
  const foundTitles = [];

  for (const line of lines) {
    // Um título de seção é curto e não termina em pontuação de frase.
    if (line.length > 60 || /[.;,]$/.test(line)) continue;
    const norm = normalizeHeading(line);
    if (!norm || norm.length < 3) continue;

    for (const key of Object.keys(aliases)) {
      const hit = aliases[key].some(a => {
        const na = stripAccents(a.toLowerCase());
        return norm === na || norm.startsWith(na + ' ') || norm === na + 's';
      });
      if (hit && !found[key]) {
        found[key] = line;
        foundTitles.push({ section: key, title: line });
      }
    }
  }

  const missing = required.filter(r => !found[r]);
  return { found, foundTitles, missingRequiredSections: missing };
}

function detectDates(text) {
  const formats = [];
  let total = 0;

  for (const f of DATE_FORMATS) {
    f.re.lastIndex = 0;
    const matches = text.match(f.re);
    if (matches && matches.length) {
      formats.push({ id: f.id, count: matches.length });
      total += matches.length;
    }
  }

  // "yyyy only" é subconjunto dos outros; só conta como formato distinto se dominar
  const ranges = (text.match(/\b(19|20)\d{2}\s*[-–—até to]{1,4}\s*((19|20)\d{2}|atual|present|current)\b/gi) || []).length;

  // Estimativa de quantas entradas de experiência existem
  const experienceEntries = Math.max(
    ranges,
    (text.match(/\n[^\n]{5,80}\s[–—-]\s[^\n]{5,80}\n/g) || []).length
  );

  return {
    formats: formats.filter(f => f.count >= 2).map(f => f.id),
    totalDates: total,
    ranges,
    entriesWithDates: ranges,
    experienceEntries: experienceEntries || (total > 0 ? 1 : 0)
  };
}

function detectBullets(text) {
  const lines = text.split('\n').filter(l => l.trim());
  const bullets = lines.filter(l => /^[\s]*[•·▪◦‣*\-–—]\s+\S/.test(l));
  return {
    count: bullets.length,
    ratio: lines.length ? bullets.length / lines.length : 0,
    samples: bullets.slice(0, 5).map(b => b.trim())
  };
}

function detectAchievements(text) {
  const bullets = detectBullets(text);
  const quantified = bullets.samples.concat(
    text.split('\n').filter(l => /^[\s]*[•·▪◦‣*\-–—]\s+/.test(l))
  ).filter(b => /\d+\s*(%|k\b|mil|milh|hours?|horas?|clientes?|clients?|R\$|\$|USD|BRL)/i.test(b)).length;

  const withVerb = text.split('\n')
    .filter(l => /^[\s]*[•·▪◦‣*\-–—]\s+/.test(l))
    .filter(l => {
      const first = stripAccents(l.replace(/^[\s]*[•·▪◦‣*\-–—]\s+/, '').split(/\s+/)[0] || '').toLowerCase();
      return ACTION_VERBS.some(v => first.startsWith(stripAccents(v).slice(0, 5)));
    }).length;

  return {
    quantified,
    actionVerbRatio: bullets.count ? withVerb / bullets.count : 0
  };
}

function detectLanguageMix(text) {
  const pt = (text.match(PT_MARKERS) || []).length;
  const en = (text.match(EN_MARKERS) || []).length;
  const total = pt + en;
  if (total < 4) return { mixed: false, pt, en, samples: [] };

  const minorityRatio = Math.min(pt, en) / total;
  const mixed = minorityRatio > 0.2;

  const samples = [];
  if (mixed) {
    const minorityRe = pt < en ? PT_MARKERS : EN_MARKERS;
    minorityRe.lastIndex = 0;
    let m;
    while ((m = minorityRe.exec(text)) !== null && samples.length < 4) samples.push(m[0]);
  }
  return { mixed, pt, en, samples };
}

function detectReadability(text) {
  const sentences = text.split(/[.!?\n]+/).map(s => s.trim()).filter(s => s.split(/\s+/).length > 2);
  if (!sentences.length) return { avgSentenceWords: 0, sentences: 0 };
  const words = sentences.reduce((acc, s) => acc + s.split(/\s+/).length, 0);
  return { avgSentenceWords: Math.round(words / sentences.length), sentences: sentences.length };
}

function detectPersonalDetails(text) {
  return PERSONAL_DETAIL_PATTERNS.filter(p => p.re.test(text)).map(p => p.label);
}

function detectHeaderFooterContact(text, contact) {
  if (!contact.email) return false;
  // Se o e-mail aparece uma única vez e nas primeiras/últimas 2 linhas úteis,
  // pode estar em cabeçalho/rodapé fora do fluxo.
  const occurrences = (text.match(new RegExp(escapeRe(contact.email), 'g')) || []).length;
  if (occurrences > 1) return false;
  const lines = text.split('\n').filter(l => l.trim());
  const idx = lines.findIndex(l => l.includes(contact.email));
  return idx === -1;
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function detectSkillCharts(text, meta) {
  if (/[█▓▒░●○◐]{2,}/.test(text)) return true;
  if (/\b(nível|level|proficiency)\s*:\s*[★☆]{2,}/i.test(text)) return true;
  return /[★☆]{3,}/.test(text);
}

function detectWorkAuthorization(text) {
  const re = /\b(work authorization|authorized to work|visa status|green card|H-?2[AB]|EAD|citizen|permanent resident|autoriza[çc][ãa]o de trabalho|visto)\b/i;
  const m = text.match(re);
  return { mentioned: Boolean(m), evidence: m ? m[0] : null };
}

function detectAvailability(text) {
  const re = /\b(available from|availability|disponibilidade|dispon[íi]vel a partir|start date|can start)\b/i;
  const m = text.match(re);
  return { mentioned: Boolean(m), evidence: m ? m[0] : null };
}

function detectLicense(text, jobContext) {
  const present = /\b(CDL|class\s?[ABC]\b|driver'?s? licen[cs]e|CNH|carteira de habilita[çc][ãa]o|habilitad[oa])\b/i.test(text);
  const required = Boolean(
    jobContext && /\b(CDL|driver'?s? licen[cs]e|valid licen[cs]e|CNH|habilita[çc][ãa]o)\b/i.test(
      [jobContext.description, jobContext.requirements].filter(Boolean).join(' ')
    )
  );
  return { present, required };
}

function detectPhysical(text) {
  const re = /\b(lift(ing)?\s*\d+|physical(ly)?|outdoor|stamina|heavy|esfor[çc]o f[íi]sico|trabalho externo|levantar)\b/i;
  return { mentioned: re.test(text) };
}

function detectTitleAlignment(text, jobContext) {
  if (!jobContext || !jobContext.title) return null;
  const head = text.split('\n').slice(0, 6).join(' ').toLowerCase();
  const jobWords = stripAccents(jobContext.title.toLowerCase())
    .split(/[^a-z0-9]+/).filter(w => w.length > 3);
  if (!jobWords.length) return null;
  const hits = jobWords.filter(w => stripAccents(head).includes(w)).length;
  return { aligned: hits / jobWords.length >= 0.34, overlap: hits, of: jobWords.length };
}

// ---------------------------------------------------------------------------

/**
 * @param {object} extraction  resultado de core/documents/textExtract
 * @param {object} ruleSet     pacote de regras resolvido (para saber quais seções exigir)
 * @param {object} jobContext  vaga opcional, para sinais dependentes de contexto
 */
function analyzeFormat(extraction, ruleSet, jobContext = null) {
  const text = extraction.text || '';
  const meta = extraction;

  const col = detectColumns(text, meta);
  const contactInfo = detectContactInfo(text);
  const aliases = (ruleSet && ruleSet.sections && ruleSet.sections.aliases) || {};
  const required = (ruleSet && ruleSet.sections && ruleSet.sections.required) || [];
  const sections = detectSections(text, aliases, required);

  const signals = {
    // estrutura
    columns: col.columns,
    columnEvidence: col.evidence,
    hasTables: detectTables(text, meta),
    hasTextBoxes: Boolean(meta.hasTextBoxes),
    hasImages: Boolean(meta.hasImages),
    hasSkillCharts: detectSkillCharts(text, meta),
    photoLikely: Boolean(meta.hasImages) && meta.format !== 'text',

    // seções e leitura
    sectionTitlesFound: sections.foundTitles,
    missingRequiredSections: sections.missingRequiredSections,
    headerFooterContact: detectHeaderFooterContact(text, contactInfo),

    // conteúdo
    contactInfo,
    dateConsistency: detectDates(text),
    bulletStructure: detectBullets(text),
    achievementSignals: detectAchievements(text),
    personalDetails: detectPersonalDetails(text),
    languageMix: detectLanguageMix(text),
    readability: detectReadability(text),

    // contexto
    workAuthorization: detectWorkAuthorization(text),
    availability: detectAvailability(text),
    licenseSignals: detectLicense(text, jobContext),
    physicalSignals: detectPhysical(text),
    titleAlignment: detectTitleAlignment(text, jobContext),

    // documento
    pageCount: extraction.pages || 0,
    wordCount: text ? text.split(/\s+/).filter(Boolean).length : 0,
    fileType: extraction.format,
    extractionConfidence: extraction.confidence
  };

  return signals;
}

/**
 * Converte a lista de issues em um status legível (spec §11).
 */
function formatStatus(issues, signals) {
  const crit = issues.filter(i => i.severity === 'CRITICAL').length;
  const high = issues.filter(i => i.severity === 'HIGH').length;
  const med = issues.filter(i => i.severity === 'MEDIUM').length;

  if (signals.extractionConfidence === 'LOW') return 'RISKY';
  if (crit > 0) return 'RISKY';
  if (high >= 2) return 'NEEDS_IMPROVEMENT';
  if (high === 1 || med >= 3) return 'NEEDS_IMPROVEMENT';
  if (med >= 1) return 'GOOD';
  return 'EXCELLENT';
}

module.exports = {
  analyzeFormat,
  formatStatus,
  detectColumns,
  detectContactInfo,
  detectSections,
  detectDates,
  detectBullets,
  detectLanguageMix,
  detectPersonalDetails,
  stripAccents
};
