const blockStart = (line, next = "") =>
  /^\s*```/.test(line) ||
  /^\s{0,3}#{1,6}\s+/.test(line) ||
  /^\s*(?:[-+*]|\d+\.)\s+/.test(line) ||
  /^\s*>\s?/.test(line) ||
  (/\|/.test(line) && tableDivider(next));

const tableDivider = (line) => {
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
};

const splitRow = (line) => {
  let value = line.trim();
  if (value.startsWith("|")) value = value.slice(1);
  if (value.endsWith("|")) value = value.slice(0, -1);
  return value.split("|").map((cell) => cell.trim());
};

const safeHref = (value) => {
  try {
    const url = new URL(value, location.origin);
    if (!["http:", "https:", "mailto:"].includes(url.protocol)) return null;
    return url.href;
  } catch {
    return null;
  }
};

function inline(text) {
  const fragment = document.createDocumentFragment();
  const pattern =
    /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\[[^\]\n]+\]\([^\s)]+\)|\*[^*\n]+\*|_[^_\n]+_)/g;
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > offset)
      fragment.append(document.createTextNode(text.slice(offset, match.index)));
    const token = match[0];
    if (token.startsWith("`")) {
      const code = document.createElement("code");
      code.textContent = token.slice(1, -1);
      fragment.append(code);
    } else if (token.startsWith("**") || token.startsWith("__")) {
      const strong = document.createElement("strong");
      strong.append(inline(token.slice(2, -2)));
      fragment.append(strong);
    } else if (token.startsWith("[")) {
      const separator = token.lastIndexOf("](");
      const href = safeHref(token.slice(separator + 2, -1));
      if (!href) fragment.append(document.createTextNode(token));
      else {
        const anchor = document.createElement("a");
        anchor.href = href;
        anchor.append(inline(token.slice(1, separator)));
        if (new URL(href).protocol !== "mailto:") {
          anchor.target = "_blank";
          anchor.rel = "noopener noreferrer";
        }
        fragment.append(anchor);
      }
    } else {
      const emphasis = document.createElement("em");
      emphasis.append(inline(token.slice(1, -1)));
      fragment.append(emphasis);
    }
    offset = match.index + token.length;
  }
  if (offset < text.length)
    fragment.append(document.createTextNode(text.slice(offset)));
  return fragment;
}

function appendTable(fragment, lines, start) {
  const headings = splitRow(lines[start]);
  const alignments = splitRow(lines[start + 1]).map((cell) =>
    cell.startsWith(":") && cell.endsWith(":")
      ? "center"
      : cell.endsWith(":")
        ? "right"
        : "left",
  );
  const table = document.createElement("table");
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  headings.forEach((value, index) => {
    const cell = document.createElement("th");
    cell.style.textAlign = alignments[index] || "left";
    cell.append(inline(value));
    headRow.append(cell);
  });
  head.append(headRow);
  table.append(head);
  const body = document.createElement("tbody");
  let index = start + 2;
  while (
    index < lines.length &&
    /\|/.test(lines[index]) &&
    lines[index].trim()
  ) {
    const row = document.createElement("tr");
    const values = splitRow(lines[index]);
    headings.forEach((_, cellIndex) => {
      const cell = document.createElement("td");
      cell.style.textAlign = alignments[cellIndex] || "left";
      cell.append(inline(values[cellIndex] || ""));
      row.append(cell);
    });
    body.append(row);
    index++;
  }
  table.append(body);
  const wrapper = document.createElement("div");
  wrapper.className = "ai-markdown-table";
  wrapper.append(table);
  fragment.append(wrapper);
  return index;
}

export function renderMarkdown(target, source) {
  const lines = String(source ?? "")
    .replaceAll("\r\n", "\n")
    .split("\n");
  const fragment = document.createDocumentFragment();
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index++;
      continue;
    }
    const fence = line.match(/^\s*```([^\s`]*)\s*$/);
    if (fence) {
      const codeLines = [];
      index++;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index]))
        codeLines.push(lines[index++]);
      if (index < lines.length) index++;
      const wrapper = document.createElement("div");
      wrapper.className = "ai-code-block";
      const header = document.createElement("div");
      const language = document.createElement("span");
      language.textContent = fence[1] || "code";
      const copy = document.createElement("button");
      copy.type = "button";
      copy.dataset.copyCode = "";
      copy.textContent = "Copy code";
      header.append(language, copy);
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.textContent = codeLines.join("\n");
      pre.append(code);
      wrapper.append(header, pre);
      fragment.append(wrapper);
      continue;
    }
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+)$/);
    if (heading) {
      const element = document.createElement(`h${heading[1].length}`);
      element.append(inline(heading[2].replace(/\s+#+\s*$/, "")));
      fragment.append(element);
      index++;
      continue;
    }
    if (/\|/.test(line) && tableDivider(lines[index + 1] || "")) {
      index = appendTable(fragment, lines, index);
      continue;
    }
    const list = line.match(/^\s*(?:([-+*])|(\d+)\.)\s+(.+)$/);
    if (list) {
      const ordered = Boolean(list[2]);
      const element = document.createElement(ordered ? "ol" : "ul");
      while (index < lines.length) {
        const item = lines[index].match(
          ordered ? /^\s*\d+\.\s+(.+)$/ : /^\s*[-+*]\s+(.+)$/,
        );
        if (!item) break;
        const listItem = document.createElement("li");
        listItem.append(inline(item[1]));
        element.append(listItem);
        index++;
      }
      fragment.append(element);
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      const quote = document.createElement("blockquote");
      const content = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index]))
        content.push(lines[index++].replace(/^\s*>\s?/, ""));
      quote.append(inline(content.join("\n")));
      fragment.append(quote);
      continue;
    }
    const paragraph = [];
    while (
      index < lines.length &&
      lines[index].trim() &&
      !blockStart(lines[index], lines[index + 1] || "")
    )
      paragraph.push(lines[index++].trim());
    const element = document.createElement("p");
    element.append(inline(paragraph.join(" ")));
    fragment.append(element);
  }
  target.classList.add("ai-markdown");
  target.replaceChildren(fragment);
}
