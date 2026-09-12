/**
 * Extração de texto de currículos — PDF e DOCX, sem dependências externas.
 *
 * Usa apenas `zlib` (nativo). A extração é heurística por natureza: PDFs podem
 * usar codificações de fonte customizadas que impedem a recuperação fiel do texto.
 * Por isso todo retorno carrega `confidence`, e o consumidor NUNCA deve tratar
 * texto de baixa confiança como fonte de verdade sobre o candidato (spec §54).
 */

const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const CONFIDENCE = { HIGH: 'HIGH', MEDIUM: 'MEDIUM', LOW: 'LOW' };

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

/**
 * Percorre os stream objects do PDF, inflaciona os que estiverem em FlateDecode
 * e extrai os operadores de texto (Tj, TJ, ', ").
 */
function extractPdfText(buffer) {
  const streams = [];
  let cursor = 0;

  while (cursor < buffer.length) {
    const start = buffer.indexOf('stream', cursor, 'latin1');
    if (start === -1) break;

    // O conteúdo começa após o EOL que segue a palavra "stream".
    let contentStart = start + 6;
    if (buffer[contentStart] === 0x0d) contentStart++;
    if (buffer[contentStart] === 0x0a) contentStart++;

    const end = buffer.indexOf('endstream', contentStart, 'latin1');
    if (end === -1) break;

    streams.push(buffer.subarray(contentStart, end));
    cursor = end + 9;
  }

  const chunks = [];
  let inflatedCount = 0;

  for (const raw of streams) {
    let data = raw;
    try {
      data = zlib.inflateSync(raw);
      inflatedCount++;
    } catch (e) {
      try {
        data = zlib.inflateRawSync(raw);
        inflatedCount++;
      } catch (e2) {
        // Stream não comprimido ou com filtro não suportado (DCTDecode, etc.).
        // Só aproveitamos se parecer conteúdo de página em texto puro.
        if (!/\bT[Jj]\b/.test(raw.toString('latin1').slice(0, 2000))) continue;
      }
    }
    chunks.push(readTextOperators(data.toString('latin1')));
  }

  const text = normalizeWhitespace(chunks.join('\n'));
  const pages = countPdfPages(buffer);

  let confidence = CONFIDENCE.LOW;
  if (text.length > 400 && inflatedCount > 0) confidence = CONFIDENCE.HIGH;
  else if (text.length > 120) confidence = CONFIDENCE.MEDIUM;

  return {
    text,
    pages,
    confidence,
    format: 'pdf',
    streamCount: streams.length,
    hasImages: /\/Subtype\s*\/Image/.test(buffer.toString('latin1')),
    warnings: confidence === CONFIDENCE.LOW
      ? ['Não foi possível extrair texto confiável deste PDF. Ele pode ser digitalizado (imagem) ou usar codificação de fonte não padrão.']
      : []
  };
}

/**
 * Lê os operadores de texto de um content stream já descomprimido.
 *
 * Trata as DUAS formas de string que o PDF admite:
 *   literal — (Ola mundo)
 *   hexadecimal — <4f6c61206d756e646f>
 * Geradores comuns (pdfkit, entre outros) emitem hexadecimal dentro de arrays TJ,
 * então ignorar essa forma resulta em extração vazia mesmo com o stream legível.
 */
function readTextOperators(content) {
  const out = [];

  // [(texto) -20 <6865783e> 0] TJ   — array com kerning
  const tjArray = /\[([^\]]*)\]\s*TJ/g;
  // (texto) Tj   |   <hex> Tj   |   ' e " (mostrar na próxima linha)
  const tjLiteral = /\(((?:[^()\\]|\\.)*)\)\s*(?:Tj|'|")/g;
  const tjHex = /<([0-9A-Fa-f\s]*)>\s*(?:Tj|'|")/g;

  // Td/TD/T*/Tm reposicionam o cursor: tratamos como quebra de linha.
  const lineBreak = /\b(?:Td|TD|T\*|Tm)\b/;

  const segments = content.split(/(?=\b(?:BT|ET|Td|TD|T\*|Tm)\b)/);

  for (const segment of segments) {
    let piece = '';
    let m;

    tjArray.lastIndex = 0;
    while ((m = tjArray.exec(segment)) !== null) {
      piece += readStringsFrom(m[1]);
    }

    tjLiteral.lastIndex = 0;
    while ((m = tjLiteral.exec(segment)) !== null) piece += decodePdfString(m[1]);

    tjHex.lastIndex = 0;
    while ((m = tjHex.exec(segment)) !== null) piece += decodeHexString(m[1]);

    if (piece) out.push(piece);
    if (lineBreak.test(segment)) out.push('\n');
  }

  return out.join('');
}

/** Extrai todas as strings (literais e hex) de dentro de um array TJ. */
function readStringsFrom(inner) {
  let text = '';
  const re = /\(((?:[^()\\]|\\.)*)\)|<([0-9A-Fa-f\s]*)>/g;
  let m;
  while ((m = re.exec(inner)) !== null) {
    text += m[1] !== undefined ? decodePdfString(m[1]) : decodeHexString(m[2]);
  }
  return text;
}

/**
 * Converte string hexadecimal do PDF em texto.
 * Pares de dígitos viram bytes; comprimento ímpar é completado com zero,
 * conforme a especificação do formato.
 */
function decodeHexString(hex) {
  const clean = String(hex || '').replace(/\s+/g, '');
  if (!clean) return '';
  const padded = clean.length % 2 ? clean + '0' : clean;

  // Sequência de UTF-16BE começa com o BOM FEFF.
  if (/^feff/i.test(padded)) {
    let s = '';
    for (let i = 4; i + 3 < padded.length + 1; i += 4) {
      s += String.fromCharCode(parseInt(padded.slice(i, i + 4), 16));
    }
    return s;
  }

  let s = '';
  for (let i = 0; i < padded.length; i += 2) {
    s += String.fromCharCode(parseInt(padded.slice(i, i + 2), 16));
  }
  return s;
}

function decodePdfString(s) {
  return s
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\b/g, '')
    .replace(/\\f/g, '')
    .replace(/\\([0-7]{1,3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)))
    .replace(/\\(.)/g, '$1');
}

function countPdfPages(buffer) {
  const latin = buffer.toString('latin1');
  const declared = latin.match(/\/Count\s+(\d+)/g);
  if (declared && declared.length) {
    const numbers = declared.map(d => parseInt(d.replace(/\/Count\s+/, ''), 10));
    const max = Math.max.apply(null, numbers);
    if (max > 0 && max < 200) return max;
  }
  const typePages = latin.match(/\/Type\s*\/Page[^s]/g);
  return typePages ? typePages.length : 1;
}

// ---------------------------------------------------------------------------
// DOCX  (zip + word/document.xml)
// ---------------------------------------------------------------------------

function extractDocxText(buffer) {
  const entries = readZipEntries(buffer);
  const doc = entries.find(e => e.name === 'word/document.xml');

  if (!doc) {
    return {
      text: '', pages: 1, confidence: CONFIDENCE.LOW, format: 'docx',
      hasImages: false,
      warnings: ['Arquivo .docx sem word/document.xml — pode estar corrompido ou não ser um DOCX válido.']
    };
  }

  const xml = doc.data.toString('utf8');

  // <w:p> = parágrafo, <w:br/> e <w:tab/> = quebras. <w:t> carrega o texto.
  const withBreaks = xml
    .replace(/<w:tab\b[^>]*\/>/g, '\t')
    .replace(/<w:br\b[^>]*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n');

  // A ordem importa: as tags são removidas ANTES de decodificar as entidades.
  // Decodificar primeiro transformaria `&lt;algo&gt;` em `<algo>`, que o
  // removedor de tags apagaria em seguida como se fosse marcação.
  const stripped = withBreaks
    .replace(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g, (_, inner) => inner)
    .replace(/<[^>]+>/g, '');

  let text = normalizeWhitespace(decodeXmlEntities(stripped));

  if (!text) {
    const parts = [];
    const re = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
    let m;
    while ((m = re.exec(withBreaks)) !== null) parts.push(decodeXmlEntities(m[1]));
    text = normalizeWhitespace(parts.join(' '));
  }

  const hasImages = /<w:drawing\b|<w:pict\b|<pic:pic\b/.test(xml);
  const hasTables = /<w:tbl\b/.test(xml);
  const hasColumns = /<w:cols\b[^>]*w:num=["'](?:[2-9]|\d{2,})["']/.test(xml);
  const hasTextBoxes = /<w:txbxContent\b|<v:textbox\b/.test(xml);

  return {
    text,
    pages: estimatePages(text),
    confidence: text.length > 200 ? CONFIDENCE.HIGH : (text.length > 60 ? CONFIDENCE.MEDIUM : CONFIDENCE.LOW),
    format: 'docx',
    hasImages,
    hasTables,
    hasColumns,
    hasTextBoxes,
    warnings: []
  };
}

/** Lê os local file headers de um ZIP e infla cada entrada. */
function readZipEntries(buffer) {
  const entries = [];
  const SIG = 0x04034b50;
  let i = 0;

  while (i < buffer.length - 4) {
    if (buffer.readUInt32LE(i) !== SIG) { i++; continue; }

    const method = buffer.readUInt16LE(i + 8);
    let compressedSize = buffer.readUInt32LE(i + 18);
    const nameLen = buffer.readUInt16LE(i + 26);
    const extraLen = buffer.readUInt16LE(i + 28);
    const nameStart = i + 30;
    const name = buffer.toString('utf8', nameStart, nameStart + nameLen);
    const dataStart = nameStart + nameLen + extraLen;

    // Data descriptor: tamanho só é conhecido no final. Procura o próximo header.
    if (compressedSize === 0) {
      let next = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]), dataStart);
      const central = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), dataStart);
      if (central !== -1 && (next === -1 || central < next)) next = central;
      compressedSize = (next === -1 ? buffer.length : next) - dataStart;
    }

    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    let data = raw;
    if (method === 8) {
      try { data = zlib.inflateRawSync(raw); } catch (e) { data = Buffer.alloc(0); }
    }

    entries.push({ name, data });
    i = dataStart + compressedSize;
  }

  return entries;
}

function decodeXmlEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&amp;/g, '&');
}

// ---------------------------------------------------------------------------
// Comum
// ---------------------------------------------------------------------------

function normalizeWhitespace(s) {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function estimatePages(text) {
  // ~3.000 caracteres por página em um currículo de densidade típica.
  return Math.max(1, Math.ceil(text.length / 3000));
}

/**
 * Ponto de entrada. Aceita caminho de arquivo ou Buffer.
 * Nunca lança: retorna sempre um objeto com `confidence` e `warnings`.
 */
function extractText(input, declaredName = '') {
  let buffer;
  let name = declaredName;

  try {
    if (Buffer.isBuffer(input)) {
      buffer = input;
    } else {
      if (!fs.existsSync(input)) {
        return emptyResult(`Arquivo não encontrado: ${input}`);
      }
      buffer = fs.readFileSync(input);
      name = name || path.basename(input);
    }
  } catch (e) {
    return emptyResult(`Não foi possível ler o arquivo: ${e.message}`);
  }

  const ext = path.extname(name || '').toLowerCase();
  const isPdf = ext === '.pdf' || buffer.subarray(0, 5).toString('latin1') === '%PDF-';
  const isZip = buffer.readUInt32LE(0) === 0x04034b50;
  const isDocx = ext === '.docx' || (isZip && ext !== '.zip');

  try {
    if (isPdf) return extractPdfText(buffer);
    if (isDocx) return extractDocxText(buffer);
    if (ext === '.txt' || ext === '.md') {
      const text = normalizeWhitespace(buffer.toString('utf8'));
      return {
        text, pages: estimatePages(text), confidence: CONFIDENCE.HIGH,
        format: 'text', hasImages: false, warnings: []
      };
    }
  } catch (e) {
    return emptyResult(`Falha ao extrair texto (${ext || 'formato desconhecido'}): ${e.message}`);
  }

  return emptyResult(`Formato não suportado para extração: ${ext || 'desconhecido'}. Use PDF, DOCX ou TXT.`);
}

function emptyResult(warning) {
  return {
    text: '', pages: 0, confidence: CONFIDENCE.LOW, format: 'unknown',
    hasImages: false, warnings: [warning]
  };
}

module.exports = {
  decodeHexString,
  extractText,
  extractPdfText,
  extractDocxText,
  readZipEntries,
  normalizeWhitespace,
  estimatePages,
  CONFIDENCE
};
