/**
 * Ontologia de habilidades e equivalência semântica (spec §14, §53).
 *
 * Regra central: equivalência NÃO é sinônimo de cobertura total. Um match
 * semântico de confiança baixa não pode contar como requisito plenamente
 * atendido (spec §53). Quem consome deve respeitar o peso por confiança.
 */

const CONFIDENCE = { HIGH: 'HIGH', MEDIUM: 'MEDIUM', LOW: 'LOW' };

/** Peso de cobertura por tipo/confiança de match (spec §53). */
const COVERAGE_WEIGHT = {
  EXACT: 1.0,
  HIGH: 0.95,
  MEDIUM: 0.65,
  LOW: 0.35
};

/**
 * Grupos de equivalência. Termos dentro do mesmo grupo são equivalentes com a
 * confiança declarada no grupo. `related` liga grupos adjacentes com confiança
 * menor (ex.: SQL e Análise de Dados se relacionam, mas não são a mesma coisa).
 */
const GROUPS = [
  // ---------- Marketing / Growth ----------
  { canonical: 'paid_media', confidence: CONFIDENCE.HIGH, label: 'Mídia paga / Performance',
    terms: ['paid media', 'performance marketing', 'midia paga', 'mídia paga', 'trafego pago', 'tráfego pago',
            'marketing de performance', 'paid acquisition', 'aquisicao paga', 'aquisição paga', 'sem', 'ppc'],
    related: [['growth', CONFIDENCE.MEDIUM], ['analytics', CONFIDENCE.LOW]] },

  { canonical: 'google_ads', confidence: CONFIDENCE.HIGH, label: 'Google Ads',
    terms: ['google ads', 'adwords', 'google adwords', 'google search ads', 'sa360', 'search ads 360'],
    related: [['paid_media', CONFIDENCE.HIGH]] },

  { canonical: 'meta_ads', confidence: CONFIDENCE.HIGH, label: 'Meta Ads',
    terms: ['meta ads', 'facebook ads', 'instagram ads', 'facebook business manager', 'meta business suite'],
    related: [['paid_media', CONFIDENCE.HIGH]] },

  { canonical: 'analytics', confidence: CONFIDENCE.HIGH, label: 'Web Analytics',
    terms: ['ga4', 'google analytics', 'google analytics 4', 'web analytics', 'analytics', 'universal analytics'],
    related: [['data_viz', CONFIDENCE.MEDIUM], ['sql', CONFIDENCE.LOW]] },

  { canonical: 'data_viz', confidence: CONFIDENCE.HIGH, label: 'Visualização de dados',
    terms: ['looker studio', 'data studio', 'google data studio', 'power bi', 'powerbi', 'tableau',
            'metabase', 'dashboards', 'data visualization', 'visualizacao de dados'],
    related: [['analytics', CONFIDENCE.MEDIUM], ['sql', CONFIDENCE.MEDIUM]] },

  { canonical: 'growth', confidence: CONFIDENCE.HIGH, label: 'Growth',
    terms: ['growth', 'growth marketing', 'growth hacking', 'cro', 'conversion rate optimization',
            'otimizacao de conversao', 'otimização de conversão', 'testes a/b', 'a/b testing', 'ab testing'] },

  // ---------- Engenharia ----------
  { canonical: 'javascript', confidence: CONFIDENCE.HIGH, label: 'JavaScript',
    terms: ['javascript', 'js', 'es6', 'ecmascript', 'javascript moderno'],
    related: [['typescript', CONFIDENCE.HIGH], ['node', CONFIDENCE.MEDIUM]] },

  { canonical: 'typescript', confidence: CONFIDENCE.HIGH, label: 'TypeScript',
    terms: ['typescript', 'ts'],
    related: [['javascript', CONFIDENCE.HIGH]] },

  { canonical: 'react', confidence: CONFIDENCE.HIGH, label: 'React',
    terms: ['react', 'react.js', 'reactjs', 'react hooks'],
    related: [['nextjs', CONFIDENCE.HIGH], ['frontend', CONFIDENCE.HIGH]] },

  { canonical: 'nextjs', confidence: CONFIDENCE.HIGH, label: 'Next.js',
    terms: ['next.js', 'nextjs', 'next js', 'react server components'],
    related: [['react', CONFIDENCE.HIGH]] },

  { canonical: 'frontend', confidence: CONFIDENCE.HIGH, label: 'Front-end',
    terms: ['frontend', 'front-end', 'front end', 'desenvolvimento web', 'html', 'css', 'web vitals', 'core web vitals'],
    related: [['react', CONFIDENCE.MEDIUM], ['tailwind', CONFIDENCE.MEDIUM]] },

  { canonical: 'tailwind', confidence: CONFIDENCE.HIGH, label: 'TailwindCSS',
    terms: ['tailwind', 'tailwindcss', 'tailwind css'],
    related: [['frontend', CONFIDENCE.MEDIUM]] },

  { canonical: 'node', confidence: CONFIDENCE.HIGH, label: 'Node.js',
    terms: ['node', 'node.js', 'nodejs', 'express', 'nestjs', 'nest.js'],
    related: [['javascript', CONFIDENCE.MEDIUM], ['backend', CONFIDENCE.HIGH]] },

  { canonical: 'python', confidence: CONFIDENCE.HIGH, label: 'Python',
    terms: ['python', 'fastapi', 'django', 'flask'],
    related: [['backend', CONFIDENCE.HIGH]] },

  { canonical: 'backend', confidence: CONFIDENCE.HIGH, label: 'Back-end',
    terms: ['backend', 'back-end', 'back end', 'apis', 'rest', 'rest apis', 'api rest', 'graphql', 'microservices', 'microsservicos', 'microsserviços'] },

  { canonical: 'sql', confidence: CONFIDENCE.HIGH, label: 'SQL / Bancos relacionais',
    terms: ['sql', 'postgresql', 'postgres', 'mysql', 'banco de dados relacional', 'relational database', 'redshift', 'bigquery'],
    related: [['data_eng', CONFIDENCE.MEDIUM], ['data_viz', CONFIDENCE.MEDIUM]] },

  { canonical: 'data_eng', confidence: CONFIDENCE.HIGH, label: 'Engenharia de dados',
    terms: ['data engineering', 'engenharia de dados', 'etl', 'airflow', 'apache airflow', 'data pipeline', 'pipelines de dados', 'data lakehouse'],
    related: [['sql', CONFIDENCE.MEDIUM], ['python', CONFIDENCE.MEDIUM]] },

  { canonical: 'cloud', confidence: CONFIDENCE.HIGH, label: 'Cloud',
    terms: ['aws', 'azure', 'gcp', 'google cloud', 'cloud', 'nuvem', 's3', 'ec2', 'lambda'],
    related: [['devops', CONFIDENCE.HIGH]] },

  { canonical: 'devops', confidence: CONFIDENCE.HIGH, label: 'DevOps',
    terms: ['devops', 'docker', 'kubernetes', 'k8s', 'terraform', 'ci/cd', 'cicd', 'github actions', 'jenkins', 'sre'],
    related: [['cloud', CONFIDENCE.HIGH]] },

  // ---------- Trabalho sazonal / H-2A e H-2B ----------
  { canonical: 'heavy_truck', confidence: CONFIDENCE.HIGH, label: 'Caminhão pesado',
    terms: ['heavy truck', 'tractor-trailer', 'tractor trailer', 'semi-truck', 'semi truck', 'semitrailer',
            'caminhao pesado', 'caminhão pesado', 'carreta', 'bitrem', 'truck driver', 'motorista de caminhao',
            'motorista de caminhão', 'grain hauler', 'hauling', 'class a cdl', 'cdl'],
    related: [['driving', CONFIDENCE.HIGH], ['ag_machinery', CONFIDENCE.MEDIUM]] },

  { canonical: 'driving', confidence: CONFIDENCE.HIGH, label: 'Direção profissional',
    terms: ['driving', 'driver', 'direcao', 'direção', 'motorista', 'commercial driving', 'mvr', 'pre-trip inspection'],
    related: [['heavy_truck', CONFIDENCE.HIGH]] },

  { canonical: 'ag_machinery', confidence: CONFIDENCE.HIGH, label: 'Maquinário agrícola',
    terms: ['tractor', 'trator', 'combine', 'colheitadeira', 'john deere', 'case ih', 'grain cart',
            'agricultural machinery', 'maquinario agricola', 'maquinário agrícola', 'harvester', 'gps autotrac', 'rtk'],
    related: [['agriculture', CONFIDENCE.HIGH], ['maintenance', CONFIDENCE.MEDIUM]] },

  { canonical: 'agriculture', confidence: CONFIDENCE.HIGH, label: 'Agricultura',
    terms: ['agriculture', 'agricola', 'agrícola', 'farm', 'fazenda', 'harvest', 'safra', 'colheita',
            'crop', 'grain', 'graos', 'grãos', 'silage', 'hay', 'livestock', 'cattle', 'gado'],
    related: [['ag_machinery', CONFIDENCE.HIGH], ['general_labor', CONFIDENCE.MEDIUM]] },

  { canonical: 'maintenance', confidence: CONFIDENCE.HIGH, label: 'Manutenção mecânica',
    terms: ['maintenance', 'manutencao', 'manutenção', 'preventive maintenance', 'mechanical', 'mecanica',
            'mecânica', 'troubleshooting', 'greasing', 'hydraulic', 'hidraulico', 'hidráulico'] },

  { canonical: 'hospitality', confidence: CONFIDENCE.HIGH, label: 'Hotelaria e alimentação',
    terms: ['hospitality', 'hotelaria', 'housekeeper', 'housekeeping', 'camareira', 'server', 'garcom',
            'garçom', 'waiter', 'waitress', 'front desk', 'recepcao', 'recepção', 'kitchen', 'cozinha',
            'food service', 'busser', 'dishwasher'],
    related: [['customer_service', CONFIDENCE.HIGH], ['general_labor', CONFIDENCE.LOW]] },

  { canonical: 'customer_service', confidence: CONFIDENCE.HIGH, label: 'Atendimento ao cliente',
    terms: ['customer service', 'atendimento ao cliente', 'guest service', 'client facing'] },

  { canonical: 'landscaping', confidence: CONFIDENCE.HIGH, label: 'Paisagismo e jardinagem',
    terms: ['landscaping', 'paisagismo', 'grounds maintenance', 'jardinagem', 'mower', 'zero-turn',
            'nursery', 'turf', 'irrigation', 'irrigacao', 'irrigação'],
    related: [['general_labor', CONFIDENCE.MEDIUM]] },

  { canonical: 'construction', confidence: CONFIDENCE.HIGH, label: 'Construção civil',
    terms: ['construction', 'construcao', 'construção', 'framing', 'concrete', 'concreto', 'carpentry',
            'carpintaria', 'masonry', 'alvenaria', 'skid steer', 'excavator'],
    related: [['general_labor', CONFIDENCE.MEDIUM], ['maintenance', CONFIDENCE.LOW]] },

  { canonical: 'general_labor', confidence: CONFIDENCE.HIGH, label: 'Trabalho braçal geral',
    terms: ['general labor', 'trabalho bracal', 'trabalho braçal', 'manual labor', 'physical labor',
            'warehouse', 'packing', 'embalagem', 'loading', 'carga e descarga'] },

  // ---------- Transversais ----------
  { canonical: 'english', confidence: CONFIDENCE.HIGH, label: 'Inglês',
    terms: ['english', 'ingles', 'inglês', 'fluent english', 'ingles fluente', 'inglês fluente'] },

  { canonical: 'spanish', confidence: CONFIDENCE.HIGH, label: 'Espanhol',
    terms: ['spanish', 'espanhol'] },

  { canonical: 'leadership', confidence: CONFIDENCE.HIGH, label: 'Liderança',
    terms: ['leadership', 'lideranca', 'liderança', 'team lead', 'supervisor', 'supervisao', 'supervisão',
            'people management', 'gestao de equipe', 'gestão de equipe'] },

  { canonical: 'stakeholder', confidence: CONFIDENCE.HIGH, label: 'Gestão de stakeholders',
    terms: ['stakeholder management', 'gestao de stakeholders', 'gestão de stakeholders', 'stakeholders'],
    related: [['leadership', CONFIDENCE.MEDIUM]] }
];

// ---------------------------------------------------------------------------

function normalize(term) {
  return String(term || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9+#./\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Índice termo -> canonical, construído uma vez.
const TERM_INDEX = new Map();
const GROUP_BY_CANONICAL = new Map();

for (const g of GROUPS) {
  GROUP_BY_CANONICAL.set(g.canonical, g);
  for (const t of g.terms) {
    TERM_INDEX.set(normalize(t), g.canonical);
  }
}

/** Resolve um termo livre para o canonical do grupo, se houver. */
function resolve(term) {
  const n = normalize(term);
  if (!n) return null;
  if (TERM_INDEX.has(n)) return TERM_INDEX.get(n);

  // Match por contenção: o termo da vaga contém um termo conhecido, ou vice-versa.
  for (const [known, canonical] of TERM_INDEX) {
    if (known.length < 4) continue;
    if (n === known) return canonical;
    if (n.includes(known) || known.includes(n)) return canonical;
  }
  return null;
}

/**
 * Compara um requisito da vaga contra um conjunto de habilidades do candidato.
 * Retorna sempre o MELHOR match encontrado, com tipo e confiança.
 *
 * @returns {{type:'EXACT'|'SEMANTIC'|'NONE', confidence:string|null,
 *            matchedWith:string|null, weight:number, explanation:string}}
 */
function matchRequirement(requirement, candidateSkills) {
  const reqNorm = normalize(requirement);
  const reqCanonical = resolve(requirement);

  let best = { type: 'NONE', confidence: null, matchedWith: null, weight: 0, explanation: '' };

  for (const skill of candidateSkills) {
    const skillNorm = normalize(skill);

    // 1. Match literal
    if (skillNorm && (skillNorm === reqNorm || skillNorm.includes(reqNorm) || reqNorm.includes(skillNorm))) {
      return {
        type: 'EXACT',
        confidence: CONFIDENCE.HIGH,
        matchedWith: skill,
        weight: COVERAGE_WEIGHT.EXACT,
        explanation: `"${skill}" corresponde literalmente ao requisito "${requirement}".`
      };
    }

    const skillCanonical = resolve(skill);
    if (!reqCanonical || !skillCanonical) continue;

    // 2. Mesmo grupo de equivalência
    if (reqCanonical === skillCanonical) {
      const g = GROUP_BY_CANONICAL.get(reqCanonical);
      const conf = g.confidence;
      const w = COVERAGE_WEIGHT[conf];
      if (w > best.weight) {
        best = {
          type: 'SEMANTIC',
          confidence: conf,
          matchedWith: skill,
          weight: w,
          explanation: `"${skill}" e "${requirement}" pertencem ao mesmo conceito (${g.label}).`
        };
      }
      continue;
    }

    // 3. Grupos relacionados
    const g = GROUP_BY_CANONICAL.get(skillCanonical);
    const link = (g.related || []).find(r => r[0] === reqCanonical);
    const reverseGroup = GROUP_BY_CANONICAL.get(reqCanonical);
    const reverseLink = (reverseGroup.related || []).find(r => r[0] === skillCanonical);
    const chosen = link || reverseLink;

    if (chosen) {
      const conf = chosen[1];
      const w = COVERAGE_WEIGHT[conf];
      if (w > best.weight) {
        best = {
          type: 'SEMANTIC',
          confidence: conf,
          matchedWith: skill,
          weight: w,
          explanation: `"${skill}" (${g.label}) é adjacente a "${requirement}" (${reverseGroup.label}), mas não é equivalente direto.`
        };
      }
    }
  }

  if (best.type === 'NONE') {
    best.explanation = `Nenhuma habilidade do perfil corresponde a "${requirement}".`;
  }
  return best;
}

/** Extrai termos conhecidos de um texto livre (descrição de vaga). */
function extractKnownTerms(text) {
  const n = normalize(text);
  const found = new Map();

  for (const g of GROUPS) {
    for (const t of g.terms) {
      const tn = normalize(t);
      if (tn.length < 3) continue;
      const re = new RegExp(`(^|[^a-z0-9])${tn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`);
      if (re.test(n)) {
        if (!found.has(g.canonical)) found.set(g.canonical, { canonical: g.canonical, label: g.label, matchedTerm: t });
        break;
      }
    }
  }
  return Array.from(found.values());
}

module.exports = {
  CONFIDENCE,
  COVERAGE_WEIGHT,
  GROUPS,
  resolve,
  normalize,
  matchRequirement,
  extractKnownTerms,
  groupFor: c => GROUP_BY_CANONICAL.get(c) || null
};
