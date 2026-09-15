/**
 * Chaves de deduplicação de vagas.
 *
 * O número do caso identifica um PEDIDO ao DOL, não uma vaga na vida real:
 * o mesmo empregador protocola vários pedidos para o mesmo cargo (lotes,
 * datas escalonadas, temporadas seguintes), e a grafia varia entre fontes
 * ("Landscape Laborers", "LANDSCAPE LABORER", "Sunshine Farms, LLC" x
 * "Sunshine Farms LLC"). Estas chaves reduzem tudo a uma forma canônica para
 * que duas linhas que são a mesma vaga caiam na mesma chave — e só elas.
 *
 * Deliberadamente conservador: só forma jurídica e pontuação saem do nome;
 * "Farms" e "Ranch" ficam, porque "Sunshine Farms" e "Sunshine Ranch" são
 * empregadores diferentes.
 */

const LEGAL_FORMS = new Set(['llc', 'inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'ltd', 'limited', 'llp', 'lp',
  'plc', 'dba', 'the', 'and']);
const TITLE_STOPWORDS = new Set(['and', 'or', 'the', 'of', 'a', 'an']);

function fold(v) {
  return String(v || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    // "L.L.C." / "Inc." → "llc" / "inc": o ponto de abreviatura não separa letras.
    .replace(/\./g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** "Sunshine Farms, L.L.C." → "sunshine farms" */
function employerKey(name) {
  const tokens = fold(name).split(' ').filter(t => t && !LEGAL_FORMS.has(t));
  return tokens.join(' ');
}

/** "Landscape Laborers" → "landscape laborer"; "Cooks / Line Cooks" → "cook line cook" */
function titleKey(title) {
  const tokens = fold(title).split(' ')
    .filter(t => t && !TITLE_STOPWORDS.has(t))
    .map(t => (t.length > 3 && /s$/.test(t) && !/ss$/.test(t) ? t.slice(0, -1) : t));
  return tokens.join(' ');
}

function cityKey(city) {
  return fold(city);
}

module.exports = { employerKey, titleKey, cityKey, fold };
