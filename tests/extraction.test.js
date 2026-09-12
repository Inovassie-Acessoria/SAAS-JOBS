/**
 * Extração de texto de documentos (PDF e DOCX) sem dependência externa.
 *
 * Regressão importante: geradores comuns de PDF emitem strings HEXADECIMAIS
 * dentro dos arrays TJ. A primeira versão do extrator só tratava strings
 * literais `(...)` e devolvia zero caracteres em currículos reais, apesar de
 * inflar o stream corretamente.
 */

const test = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');

const {
  extractPdfText, extractDocxText, decodeHexString,
  normalizeWhitespace, estimatePages, CONFIDENCE
} = require('../core/documents/textExtract');

/** Monta um PDF mínimo com um content stream comprimido. */
function makePdf(contentStream, { withImage = false } = {}) {
  const deflated = zlib.deflateSync(Buffer.from(contentStream, 'latin1'));
  const head = Buffer.from(
    `%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n` +
    `2 0 obj<</Type/Pages/Count 1>>endobj\n` +
    `3 0 obj<</Type/Page/Resources<</Font<</F1 4 0 R>>>>>>endobj\n` +
    (withImage ? `5 0 obj<</Subtype/Image/Width 10>>endobj\n` : '') +
    `6 0 obj<</Filter/FlateDecode/Length ${deflated.length}>>\nstream\n`, 'latin1');
  const tail = Buffer.from(`\nendstream\nendobj\n%%EOF`, 'latin1');
  return Buffer.concat([head, deflated, tail]);
}

// ---------------------------------------------------------------------------

test('decodeHexString converte hexadecimal do PDF em texto', () => {
  assert.strictEqual(decodeHexString('4c75636173'), 'Lucas');
  assert.strictEqual(decodeHexString('4c 75 63 61 73'), 'Lucas', 'espaços são ignorados');
  assert.strictEqual(decodeHexString(''), '');

  // Comprimento ímpar é completado com zero, conforme a especificação.
  assert.strictEqual(decodeHexString('414'), 'A@');

  // UTF-16BE com BOM
  assert.strictEqual(decodeHexString('feff004f006c00e1'), 'Olá');
});

test('REGRESSÃO — PDF com strings hexadecimais em array TJ é extraído', () => {
  // Formato exatamente igual ao que geradores reais produzem.
  const content = 'BT\n1 0 0 1 72 720 Tm\n/F1 12 Tf\n' +
    '[<4c756361732046657272656972612064612053696c76> 20 <61> 0] TJ\nET\n' +
    'BT\n1 0 0 1 72 700 Tm\n' +
    '[<53656e696f7220456e67696e656572> 0] TJ\nET\n';

  const r = extractPdfText(makePdf(content));

  assert.ok(r.text.includes('Lucas Ferreira da Silva'),
    `o nome deveria ter sido extraído; veio: ${JSON.stringify(r.text)}`);
  assert.ok(r.text.includes('Senior Engineer'));
  assert.strictEqual(r.format, 'pdf');
});

test('PDF com strings literais continua funcionando', () => {
  const content = 'BT\n/F1 12 Tf\n1 0 0 1 72 720 Tm\n(Maria Silva) Tj\nET\n' +
    'BT\n1 0 0 1 72 700 Tm\n[(Paid Media) -20 (Specialist)] TJ\nET\n';
  const r = extractPdfText(makePdf(content));

  assert.ok(r.text.includes('Maria Silva'));
  assert.ok(r.text.includes('Paid Media'));
  assert.ok(r.text.includes('Specialist'));
});

test('literal e hexadecimal misturados no mesmo array TJ', () => {
  const content = 'BT\n1 0 0 1 72 720 Tm\n[(Google ) <416473> ( e ) <4d65746120416473>] TJ\nET\n';
  const r = extractPdfText(makePdf(content));
  assert.ok(r.text.includes('Google Ads'), r.text);
  assert.ok(r.text.includes('Meta Ads'), r.text);
});

test('reposicionamento do cursor vira quebra de linha', () => {
  const content = 'BT\n1 0 0 1 72 720 Tm\n(Linha um) Tj\nET\nBT\n1 0 0 1 72 700 Tm\n(Linha dois) Tj\nET\n';
  const r = extractPdfText(makePdf(content));
  assert.ok(/Linha um\s*\n\s*Linha dois/.test(r.text),
    `linhas deveriam ficar separadas; veio: ${JSON.stringify(r.text)}`);
});

test('PDF sem texto recuperável é marcado LOW com aviso, não como sucesso', () => {
  const r = extractPdfText(makePdf('q 1 0 0 1 0 0 cm Q\n'));
  assert.strictEqual(r.confidence, CONFIDENCE.LOW);
  assert.ok(r.warnings.length > 0);
  assert.match(r.warnings[0], /digitalizado|não padrão/i);
});

test('imagem no PDF é detectada — insumo para a regra de foto', () => {
  const content = 'BT\n1 0 0 1 72 720 Tm\n(Texto com imagem no documento) Tj\nET\n';
  assert.strictEqual(extractPdfText(makePdf(content, { withImage: true })).hasImages, true);
  assert.strictEqual(extractPdfText(makePdf(content)).hasImages, false);
});

test('confiança acompanha o volume de texto recuperado', () => {
  const long = 'BT\n1 0 0 1 72 720 Tm\n(' + 'Experiência profissional relevante. '.repeat(20) + ') Tj\nET\n';
  assert.strictEqual(extractPdfText(makePdf(long)).confidence, CONFIDENCE.HIGH);

  const medium = 'BT\n1 0 0 1 72 720 Tm\n(' + 'Texto curto de currículo. '.repeat(6) + ') Tj\nET\n';
  assert.strictEqual(extractPdfText(makePdf(medium)).confidence, CONFIDENCE.MEDIUM);
});

// ---------------------------------------------------------------------------

/** Monta um DOCX mínimo: ZIP com word/document.xml em deflate bruto. */
function makeDocx(innerXml) {
  const name = Buffer.from('word/document.xml', 'utf8');
  const data = zlib.deflateRawSync(Buffer.from(
    `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>${innerXml}</w:body></w:document>`, 'utf8'));

  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt16LE(8, 8);              // método: deflate
  header.writeUInt32LE(0, 14);             // crc (não verificado)
  header.writeUInt32LE(data.length, 18);   // tamanho comprimido
  header.writeUInt32LE(0, 22);
  header.writeUInt16LE(name.length, 26);
  header.writeUInt16LE(0, 28);

  const central = Buffer.alloc(4);
  central.writeUInt32LE(0x02014b50, 0);
  return Buffer.concat([header, name, data, central]);
}

test('DOCX — texto dos parágrafos é extraído', () => {
  const r = extractDocxText(makeDocx(
    '<w:p><w:r><w:t>Maria Silva</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>Paid Media Manager</w:t></w:r></w:p>'
  ));
  assert.ok(r.text.includes('Maria Silva'), r.text);
  assert.ok(r.text.includes('Paid Media Manager'));
  assert.strictEqual(r.confidence, CONFIDENCE.LOW, 'texto curto tem confiança baixa');
  assert.strictEqual(r.format, 'docx');
});

test('DOCX — tabela, caixa de texto, imagem e colunas são detectadas', () => {
  const rich = extractDocxText(makeDocx(
    '<w:sectPr><w:cols w:num="2"/></w:sectPr>' +
    '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Célula</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' +
    '<w:p><w:r><w:drawing/></w:r></w:p>' +
    '<w:txbxContent><w:p><w:r><w:t>Dentro da caixa</w:t></w:r></w:p></w:txbxContent>'
  ));

  assert.strictEqual(rich.hasTables, true);
  assert.strictEqual(rich.hasImages, true);
  assert.strictEqual(rich.hasTextBoxes, true);
  assert.strictEqual(rich.hasColumns, true);

  const plain = extractDocxText(makeDocx('<w:p><w:r><w:t>Texto simples</w:t></w:r></w:p>'));
  assert.strictEqual(plain.hasTables, false);
  assert.strictEqual(plain.hasImages, false);
  assert.strictEqual(plain.hasTextBoxes, false);
});

test('DOCX — entidades XML são decodificadas', () => {
  const r = extractDocxText(makeDocx('<w:p><w:r><w:t>P&amp;D &lt;interno&gt;</w:t></w:r></w:p>'));
  assert.ok(r.text.includes('P&D'), r.text);
  assert.ok(r.text.includes('<interno>'), r.text);
});

test('utilitários de normalização', () => {
  assert.strictEqual(normalizeWhitespace('  a   b  \r\n\r\n\r\n c '), 'a b\n\nc');
  assert.strictEqual(estimatePages(''), 1);
  assert.strictEqual(estimatePages('x'.repeat(3000)), 1);
  assert.strictEqual(estimatePages('x'.repeat(3001)), 2);
});
