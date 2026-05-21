// Universal Word + PDF exporters.
//
// Every artifact lives in the database as markdown (often with embedded
// Mermaid blocks, tables, lists, and code). These two functions walk the
// `marked` token tree once and emit either a .docx (via `docx`) or a .pdf
// (via `pdfkit`) buffer.
//
// Used by `backend/src/server.js` `GET /api/artifacts/:id/export?format=word|pdf`.
//
// Mermaid handling: PDF/Word do not run JS, so a Mermaid block can't be
// rendered as a real diagram from inside Node. We emit the diagram's
// source as a monospace code block with a small "(diagram source)" caption
// instead — readable, and the user can paste it into any Mermaid renderer.

const { marked } = require("marked");
const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
  WidthType,
  AlignmentType,
  BorderStyle,
  ShadingType,
} = require("docx");
const PDFDocument = require("pdfkit");

// ============================================================
//   Shared markdown → token tree
// ============================================================
function tokenize(md) {
  // Disable GFM line breaks so a soft \n inside a paragraph doesn't
  // create a fake <br>. Tables, code, lists all stay supported.
  return marked.lexer(md || "", { gfm: true, breaks: false });
}

// Flatten inline tokens (em, strong, codespan, link, text) into a plain
// string. Used by both renderers for cases where we don't want to recurse
// (e.g. inside a list item bullet or table cell).
function inlineText(tokens) {
  if (!tokens || !tokens.length) return "";
  return tokens
    .map((t) => {
      if (t.type === "text") return t.text;
      if (t.type === "escape") return t.text;
      if (t.type === "strong") return inlineText(t.tokens);
      if (t.type === "em") return inlineText(t.tokens);
      if (t.type === "codespan") return t.text;
      if (t.type === "link") return inlineText(t.tokens) + " (" + t.href + ")";
      if (t.type === "image") return "[image: " + (t.text || t.href) + "]";
      if (t.type === "del") return inlineText(t.tokens);
      if (t.type === "br") return "\n";
      if (t.type === "html") return "";
      return t.raw || "";
    })
    .join("");
}

// ============================================================
//   Word (.docx) renderer
// ============================================================

// docx@9 uses TextRun for inline formatting. We turn marked inline tokens
// into an array of TextRun objects so bold/italic/code stay live in Word.
function inlineRuns(tokens, baseStyle = {}) {
  const runs = [];
  if (!tokens || !tokens.length) return runs;
  for (const t of tokens) {
    if (t.type === "text" || t.type === "escape") {
      runs.push(new TextRun({ text: t.text, ...baseStyle }));
    } else if (t.type === "strong") {
      runs.push(...inlineRuns(t.tokens, { ...baseStyle, bold: true }));
    } else if (t.type === "em") {
      runs.push(...inlineRuns(t.tokens, { ...baseStyle, italics: true }));
    } else if (t.type === "codespan") {
      runs.push(new TextRun({ text: t.text, font: "Consolas", ...baseStyle }));
    } else if (t.type === "del") {
      runs.push(...inlineRuns(t.tokens, { ...baseStyle, strike: true }));
    } else if (t.type === "link") {
      runs.push(...inlineRuns(t.tokens, { ...baseStyle, color: "2563EB", underline: {} }));
      runs.push(new TextRun({ text: " (" + t.href + ")", color: "6B7280", size: 18 }));
    } else if (t.type === "br") {
      runs.push(new TextRun({ text: "", break: 1 }));
    } else if (t.type === "image") {
      runs.push(new TextRun({ text: "[image: " + (t.text || t.href) + "]", italics: true, color: "6B7280" }));
    } else {
      runs.push(new TextRun({ text: t.raw || "", ...baseStyle }));
    }
  }
  return runs;
}

const HEADING_LEVELS = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
  4: HeadingLevel.HEADING_4,
  5: HeadingLevel.HEADING_5,
  6: HeadingLevel.HEADING_6,
};

function renderListItemDocx(item, depth, ordered) {
  const blocks = [];
  const prefix = ordered ? "" : "• ";
  // The bullet/number indents itself via the list style if we used real
  // numbering — but plain "• " + indent works fine for handoff docs.
  blocks.push(
    new Paragraph({
      children: [
        new TextRun({ text: prefix, bold: true }),
        ...inlineRuns(item.tokens || []),
      ],
      indent: { left: 360 * (depth + 1) },
      spacing: { before: 60, after: 60 },
    })
  );
  // Nested lists inside the item
  if (item.tokens) {
    for (const sub of item.tokens) {
      if (sub.type === "list") {
        for (const subItem of sub.items) {
          blocks.push(...renderListItemDocx(subItem, depth + 1, sub.ordered));
        }
      }
    }
  }
  return blocks;
}

function renderTableDocx(token) {
  const headerCells = (token.header || []).map((cell) =>
    new TableCell({
      children: [
        new Paragraph({
          children: inlineRuns(cell.tokens || [{ type: "text", text: cell.text || "" }], { bold: true }),
        }),
      ],
      shading: { type: ShadingType.CLEAR, color: "auto", fill: "F3F4F6" },
    })
  );
  const headerRow = new TableRow({ children: headerCells, tableHeader: true });

  const bodyRows = (token.rows || []).map((row) =>
    new TableRow({
      children: row.map(
        (cell) =>
          new TableCell({
            children: [
              new Paragraph({
                children: inlineRuns(cell.tokens || [{ type: "text", text: cell.text || "" }]),
              }),
            ],
          })
      ),
    })
  );

  return new Table({
    rows: [headerRow, ...bodyRows],
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top:    { style: BorderStyle.SINGLE, size: 4, color: "D1D5DB" },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: "D1D5DB" },
      left:   { style: BorderStyle.SINGLE, size: 4, color: "D1D5DB" },
      right:  { style: BorderStyle.SINGLE, size: 4, color: "D1D5DB" },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: "E5E7EB" },
      insideVertical:   { style: BorderStyle.SINGLE, size: 4, color: "E5E7EB" },
    },
  });
}

function renderCodeBlockDocx(token) {
  const isMermaid = (token.lang || "").toLowerCase() === "mermaid";
  const caption = isMermaid
    ? "Diagram source (paste into any Mermaid renderer to view):"
    : (token.lang ? `${token.lang} code:` : "Code:");
  const captionPara = new Paragraph({
    children: [new TextRun({ text: caption, italics: true, color: "6B7280", size: 18 })],
    spacing: { before: 120, after: 60 },
  });
  const codeLines = String(token.text || "").split("\n").map(
    (line) =>
      new Paragraph({
        children: [new TextRun({ text: line || " ", font: "Consolas", size: 20 })],
        shading: { type: ShadingType.CLEAR, color: "auto", fill: "F3F4F6" },
        spacing: { before: 0, after: 0 },
      })
  );
  return [captionPara, ...codeLines];
}

function renderTokensDocx(tokens) {
  const out = [];
  for (const t of tokens) {
    if (t.type === "heading") {
      out.push(
        new Paragraph({
          heading: HEADING_LEVELS[t.depth] || HeadingLevel.HEADING_3,
          children: inlineRuns(t.tokens || []),
          spacing: { before: 240, after: 120 },
        })
      );
    } else if (t.type === "paragraph") {
      out.push(
        new Paragraph({
          children: inlineRuns(t.tokens || []),
          spacing: { before: 80, after: 80 },
        })
      );
    } else if (t.type === "list") {
      for (const item of t.items) {
        out.push(...renderListItemDocx(item, 0, t.ordered));
      }
    } else if (t.type === "table") {
      out.push(renderTableDocx(t));
      out.push(new Paragraph({ children: [new TextRun({ text: "" })] }));
    } else if (t.type === "code") {
      out.push(...renderCodeBlockDocx(t));
    } else if (t.type === "blockquote") {
      // Blockquote contents are nested tokens — render them indented + italic.
      const inner = renderTokensDocx(t.tokens || []);
      for (const block of inner) {
        if (block instanceof Paragraph) {
          // Re-indent via constructor would be invasive; just push as-is.
          out.push(block);
        } else {
          out.push(block);
        }
      }
    } else if (t.type === "hr") {
      out.push(
        new Paragraph({
          children: [new TextRun({ text: "" })],
          border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "D1D5DB" } },
          spacing: { before: 120, after: 120 },
        })
      );
    } else if (t.type === "space") {
      // skip — docx adds its own paragraph spacing
    } else if (t.type === "html") {
      // Don't try to interpret raw HTML — fall back to plain text.
      const stripped = String(t.raw || "").replace(/<[^>]+>/g, " ").trim();
      if (stripped) {
        out.push(new Paragraph({ children: [new TextRun({ text: stripped })] }));
      }
    } else if (t.type === "text") {
      out.push(new Paragraph({ children: inlineRuns(t.tokens || [{ type: "text", text: t.text || "" }]) }));
    }
  }
  return out;
}

async function markdownToDocx(markdown, { title, artifactType } = {}) {
  const tokens = tokenize(markdown);
  const body = renderTokensDocx(tokens);

  const header = [];
  if (title) {
    header.push(
      new Paragraph({
        heading: HeadingLevel.TITLE,
        children: [new TextRun({ text: title, bold: true })],
        alignment: AlignmentType.LEFT,
        spacing: { after: 120 },
      })
    );
  }
  if (artifactType) {
    header.push(
      new Paragraph({
        children: [
          new TextRun({ text: "Artifact type: ", italics: true, color: "6B7280" }),
          new TextRun({ text: String(artifactType).replace(/_/g, " "), italics: true, color: "6B7280" }),
        ],
        spacing: { after: 240 },
      })
    );
  }

  const doc = new Document({
    creator: "Plan Forge",
    title: title || "Plan Forge artifact",
    description: artifactType ? `Plan Forge artifact (${artifactType})` : "Plan Forge artifact",
    styles: {
      default: {
        document: { run: { font: "Calibri", size: 22 } },
      },
    },
    sections: [
      {
        properties: {},
        children: [...header, ...body],
      },
    ],
  });

  const buffer = await Packer.toBuffer(doc);
  return buffer;
}

// ============================================================
//   PDF renderer (pdfkit)
// ============================================================

// Style tokens for PDFKit — chosen to match the Plan Forge editorial
// design system roughly (warm graphite text, restrained accent colors).
const PDF_STYLE = {
  font:     "Helvetica",
  fontBold: "Helvetica-Bold",
  fontItal: "Helvetica-Oblique",
  fontMono: "Courier",
  text:     "#1f2937",
  muted:    "#6b7280",
  rule:     "#d1d5db",
  codeBg:   "#f3f4f6",
  link:     "#2563eb",
  headSize: { 1: 22, 2: 18, 3: 15, 4: 13, 5: 12, 6: 11 },
  bodySize: 11,
  lineGap:  3,
};

function writeInlinePdf(doc, tokens, baseStyle = {}) {
  if (!tokens || !tokens.length) return;
  const flush = (text, style) => {
    if (!text) return;
    doc.font(style.font || PDF_STYLE.font);
    doc.fillColor(style.color || PDF_STYLE.text);
    doc.fontSize(style.size || PDF_STYLE.bodySize);
    doc.text(text, { continued: !!style.continued, lineGap: PDF_STYLE.lineGap });
  };
  // We accumulate as continued runs and end with a single non-continued text.
  // To do that we look ahead and mark the last run as not continued.
  const expanded = [];
  for (const t of tokens) {
    if (t.type === "text" || t.type === "escape") {
      expanded.push({ text: t.text, style: { ...baseStyle } });
    } else if (t.type === "strong") {
      expanded.push(...inlineRunsForPdf(t.tokens, { ...baseStyle, font: PDF_STYLE.fontBold }));
    } else if (t.type === "em") {
      expanded.push(...inlineRunsForPdf(t.tokens, { ...baseStyle, font: PDF_STYLE.fontItal }));
    } else if (t.type === "codespan") {
      expanded.push({ text: t.text, style: { ...baseStyle, font: PDF_STYLE.fontMono } });
    } else if (t.type === "del") {
      expanded.push({ text: t.text || inlineText(t.tokens), style: { ...baseStyle, color: PDF_STYLE.muted } });
    } else if (t.type === "link") {
      expanded.push({ text: inlineText(t.tokens) + " (" + t.href + ")", style: { ...baseStyle, color: PDF_STYLE.link } });
    } else if (t.type === "br") {
      expanded.push({ text: "\n", style: { ...baseStyle } });
    } else if (t.type === "image") {
      expanded.push({ text: "[image: " + (t.text || t.href) + "]", style: { ...baseStyle, color: PDF_STYLE.muted, font: PDF_STYLE.fontItal } });
    } else {
      expanded.push({ text: t.raw || "", style: { ...baseStyle } });
    }
  }
  expanded.forEach((seg, i) => {
    const last = i === expanded.length - 1;
    flush(seg.text, { ...seg.style, continued: !last });
  });
}

// Helper used by writeInlinePdf to fully resolve nested inline tokens
// (strong/em can contain more runs) into a flat list of {text, style}.
function inlineRunsForPdf(tokens, baseStyle) {
  const out = [];
  if (!tokens || !tokens.length) return out;
  for (const t of tokens) {
    if (t.type === "text" || t.type === "escape") {
      out.push({ text: t.text, style: { ...baseStyle } });
    } else if (t.type === "strong") {
      out.push(...inlineRunsForPdf(t.tokens, { ...baseStyle, font: PDF_STYLE.fontBold }));
    } else if (t.type === "em") {
      out.push(...inlineRunsForPdf(t.tokens, { ...baseStyle, font: PDF_STYLE.fontItal }));
    } else if (t.type === "codespan") {
      out.push({ text: t.text, style: { ...baseStyle, font: PDF_STYLE.fontMono } });
    } else if (t.type === "link") {
      out.push({ text: inlineText(t.tokens) + " (" + t.href + ")", style: { ...baseStyle, color: PDF_STYLE.link } });
    } else {
      out.push({ text: t.raw || "", style: { ...baseStyle } });
    }
  }
  return out;
}

function ensureRoom(doc, needed = 100) {
  const remaining = doc.page.height - doc.page.margins.bottom - doc.y;
  if (remaining < needed) doc.addPage();
}

function renderTablePdf(doc, token) {
  const cols = (token.header || []).length;
  if (!cols) return;
  const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const colWidth = pageWidth / cols;
  const padding = 6;
  const lineGap = 2;

  function measure(text, font, size) {
    doc.font(font).fontSize(size);
    return doc.heightOfString(text, { width: colWidth - 2 * padding, lineGap });
  }

  function drawRow(cells, opts) {
    const isHeader = !!opts.header;
    const font = isHeader ? PDF_STYLE.fontBold : PDF_STYLE.font;
    const size = PDF_STYLE.bodySize;
    // Compute the row's height as the max cell height
    const heights = cells.map((c) => measure(c, font, size));
    const rowH = Math.max(...heights, 18) + 2 * padding;
    ensureRoom(doc, rowH + 4);
    const y0 = doc.y;
    const x0 = doc.page.margins.left;
    // Background
    if (isHeader) {
      doc.save();
      doc.rect(x0, y0, pageWidth, rowH).fill(PDF_STYLE.codeBg);
      doc.restore();
    }
    // Borders
    doc.save();
    doc.strokeColor(PDF_STYLE.rule).lineWidth(0.5);
    doc.rect(x0, y0, pageWidth, rowH).stroke();
    for (let i = 1; i < cols; i++) {
      doc.moveTo(x0 + i * colWidth, y0).lineTo(x0 + i * colWidth, y0 + rowH).stroke();
    }
    doc.restore();
    // Cell text
    cells.forEach((cell, i) => {
      doc.font(font).fontSize(size).fillColor(PDF_STYLE.text);
      doc.text(cell, x0 + i * colWidth + padding, y0 + padding, {
        width: colWidth - 2 * padding,
        lineGap,
      });
    });
    doc.y = y0 + rowH;
  }

  const headerCells = (token.header || []).map((c) => inlineText(c.tokens || [{ type: "text", text: c.text || "" }]));
  drawRow(headerCells, { header: true });
  for (const row of token.rows || []) {
    const cells = row.map((c) => inlineText(c.tokens || [{ type: "text", text: c.text || "" }]));
    drawRow(cells, { header: false });
  }
  doc.moveDown(0.6);
}

function renderCodeBlockPdf(doc, token) {
  const isMermaid = (token.lang || "").toLowerCase() === "mermaid";
  const caption = isMermaid
    ? "Diagram source (paste into any Mermaid renderer to view):"
    : (token.lang ? `${token.lang} code:` : "Code:");
  ensureRoom(doc, 60);
  doc.font(PDF_STYLE.fontItal).fontSize(9).fillColor(PDF_STYLE.muted);
  doc.text(caption, { lineGap: PDF_STYLE.lineGap });
  doc.moveDown(0.2);
  const codeText = String(token.text || "");
  const padding = 6;
  const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const lineGap = 2;
  doc.font(PDF_STYLE.fontMono).fontSize(9);
  const h = doc.heightOfString(codeText || " ", { width: pageWidth - 2 * padding, lineGap });
  ensureRoom(doc, h + 2 * padding + 4);
  const y0 = doc.y;
  doc.save();
  doc.rect(doc.page.margins.left, y0, pageWidth, h + 2 * padding).fill(PDF_STYLE.codeBg);
  doc.restore();
  doc.font(PDF_STYLE.fontMono).fontSize(9).fillColor(PDF_STYLE.text);
  doc.text(codeText || " ", doc.page.margins.left + padding, y0 + padding, {
    width: pageWidth - 2 * padding,
    lineGap,
  });
  doc.y = y0 + h + 2 * padding + 4;
  doc.moveDown(0.3);
}

function renderListItemPdf(doc, item, depth, ordered, idx) {
  ensureRoom(doc, 30);
  const indent = doc.page.margins.left + 14 * depth;
  const bullet = ordered ? `${idx + 1}. ` : "• ";
  doc.font(PDF_STYLE.fontBold).fontSize(PDF_STYLE.bodySize).fillColor(PDF_STYLE.text);
  doc.text(bullet, indent, doc.y, { continued: true, lineGap: PDF_STYLE.lineGap });
  doc.font(PDF_STYLE.font);
  writeInlinePdf(doc, item.tokens || []);
  // Nested lists
  if (item.tokens) {
    for (const sub of item.tokens) {
      if (sub.type === "list") {
        sub.items.forEach((it, i) => renderListItemPdf(doc, it, depth + 1, sub.ordered, i));
      }
    }
  }
}

function renderTokensPdf(doc, tokens) {
  for (const t of tokens) {
    if (t.type === "heading") {
      ensureRoom(doc, 40);
      const size = PDF_STYLE.headSize[t.depth] || 12;
      doc.moveDown(0.4);
      doc.font(PDF_STYLE.fontBold).fontSize(size).fillColor(PDF_STYLE.text);
      doc.text(inlineText(t.tokens || []), { lineGap: PDF_STYLE.lineGap });
      doc.moveDown(0.2);
    } else if (t.type === "paragraph") {
      ensureRoom(doc, 30);
      writeInlinePdf(doc, t.tokens || []);
      doc.moveDown(0.4);
    } else if (t.type === "list") {
      t.items.forEach((it, i) => renderListItemPdf(doc, it, 0, t.ordered, i));
      doc.moveDown(0.3);
    } else if (t.type === "table") {
      renderTablePdf(doc, t);
    } else if (t.type === "code") {
      renderCodeBlockPdf(doc, t);
    } else if (t.type === "blockquote") {
      ensureRoom(doc, 30);
      const x0 = doc.page.margins.left;
      const yStart = doc.y;
      const left = x0 + 8;
      doc.x = left;
      const oldMargin = doc.page.margins.left;
      doc.page.margins.left = left + 6;
      renderTokensPdf(doc, t.tokens || []);
      doc.page.margins.left = oldMargin;
      doc.save();
      doc.strokeColor(PDF_STYLE.rule).lineWidth(2);
      doc.moveTo(x0 + 3, yStart).lineTo(x0 + 3, doc.y).stroke();
      doc.restore();
    } else if (t.type === "hr") {
      ensureRoom(doc, 20);
      doc.moveDown(0.4);
      doc.save();
      doc.strokeColor(PDF_STYLE.rule).lineWidth(0.5);
      const x0 = doc.page.margins.left;
      const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
      doc.moveTo(x0, doc.y).lineTo(x0 + pageWidth, doc.y).stroke();
      doc.restore();
      doc.moveDown(0.4);
    } else if (t.type === "space") {
      doc.moveDown(0.3);
    } else if (t.type === "html") {
      const stripped = String(t.raw || "").replace(/<[^>]+>/g, " ").trim();
      if (stripped) {
        doc.font(PDF_STYLE.font).fontSize(PDF_STYLE.bodySize).fillColor(PDF_STYLE.text);
        doc.text(stripped, { lineGap: PDF_STYLE.lineGap });
      }
    }
  }
}

async function markdownToPdf(markdown, { title, artifactType } = {}) {
  const doc = new PDFDocument({
    size: "A4",
    margins: { top: 56, bottom: 56, left: 56, right: 56 },
    info: {
      Title: title || "Plan Forge artifact",
      Author: "Plan Forge",
      Subject: artifactType ? `Plan Forge artifact (${artifactType})` : "Plan Forge artifact",
    },
  });

  // Collect chunks into a buffer that we return at the end. PDFKit streams
  // by default; we capture the stream and resolve when it ends.
  const chunks = [];
  return new Promise((resolve, reject) => {
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    // Title block
    if (title) {
      doc.font(PDF_STYLE.fontBold).fontSize(22).fillColor(PDF_STYLE.text);
      doc.text(title, { lineGap: PDF_STYLE.lineGap });
    }
    if (artifactType) {
      doc.moveDown(0.15);
      doc.font(PDF_STYLE.fontItal).fontSize(10).fillColor(PDF_STYLE.muted);
      doc.text("Artifact type: " + String(artifactType).replace(/_/g, " "), { lineGap: PDF_STYLE.lineGap });
    }
    if (title || artifactType) {
      doc.moveDown(0.4);
      doc.save();
      doc.strokeColor(PDF_STYLE.rule).lineWidth(0.5);
      const x0 = doc.page.margins.left;
      const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
      doc.moveTo(x0, doc.y).lineTo(x0 + pageWidth, doc.y).stroke();
      doc.restore();
      doc.moveDown(0.4);
    }

    const tokens = tokenize(markdown);
    renderTokensPdf(doc, tokens);

    doc.end();
  });
}

module.exports = { markdownToDocx, markdownToPdf };
