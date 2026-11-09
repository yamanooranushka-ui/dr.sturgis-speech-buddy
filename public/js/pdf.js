/* Plain text PDF (Helvetica). Enough for the speech-insights report. */

function sanitize(text) {
  return String(text ?? "")
    .replace(/\u2014|\u2013/g, "-")
    .replace(/\u2018|\u2019/g, "'")
    .replace(/\u201C|\u201D/g, '"')
    .replace(/[^\x20-\x7E]/g, "");
}

function pdfEscape(text) {
  return sanitize(text).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function wrap(text, size) {
  const width = size >= 16 ? 58 : size >= 13 ? 74 : 90;
  const words = sanitize(text).split(/\s+/).filter(Boolean);
  if (!words.length) return [""];
  const lines = [];
  let current = "";
  for (const word of words) {
    const next = current ? current + " " + word : word;
    if (next.length > width && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function paginate(blocks) {
  const pages = [];
  let page = [];
  let y = 748;
  for (const block of blocks) {
    const size = block.size || 11;
    const gap = block.gap || size + 5;
    for (const text of wrap(block.text, size)) {
      if (y - gap < 52) {
        pages.push(page);
        page = [];
        y = 748;
      }
      page.push({ text, bold: !!block.bold, size, gap });
      y -= gap;
    }
  }
  if (page.length) pages.push(page);
  if (!pages.length) pages.push([{ text: "No speech insights yet.", bold: false, size: 12, gap: 18 }]);
  return pages;
}

function pageStream(lines) {
  const parts = ["BT"];
  let y = 748;
  for (const line of lines) {
    const font = line.bold ? "/F2" : "/F1";
    parts.push(`${font} ${line.size} Tf`);
    parts.push(`1 0 0 1 54 ${y} Tm`);
    parts.push(`(${pdfEscape(line.text)}) Tj`);
    y -= line.gap;
  }
  parts.push("ET");
  return parts.join("\n");
}

function assemble(streams) {
  const objs = [];
  objs[1] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  objs[2] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>";
  let next = 3;
  const contentIds = [];
  for (const stream of streams) {
    contentIds.push(next);
    objs[next] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
    next += 1;
  }
  const pageIds = [];
  const pagesId = next + streams.length;
  for (let i = 0; i < streams.length; i += 1) {
    pageIds.push(next);
    objs[next] =
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] ` +
      `/Contents ${contentIds[i]} 0 R /Resources << /Font << /F1 1 0 R /F2 2 0 R >> >> >>`;
    next += 1;
  }
  objs[next] = `<< /Type /Pages /Kids [${pageIds.map((id) => id + " 0 R").join(" ")}] /Count ${pageIds.length} >>`;
  const pagesObj = next;
  next += 1;
  const catalog = next;
  objs[next] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;

  let out = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 1; i <= next; i += 1) {
    offsets[i] = out.length;
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${next + 1}\n`;
  out += "0000000000 65535 f \n";
  for (let i = 1; i <= next; i += 1) {
    out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${next + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return out;
}

export function downloadPdf(filename, blocks) {
  const pdf = assemble(paginate(blocks).map(pageStream));
  const blob = new Blob([pdf], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
