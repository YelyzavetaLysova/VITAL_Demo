/* Navigate to literal wording and conservative, inspectable variants. */
(() => {
  let lastKey = "",
    lastIndex = -1,
    timer;
  const excluded =
    'script,style,nav,footer,aside,[hidden],[aria-hidden="true"],#vital-demo-panel';
  const fold = (value) =>
    value.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase();
  function words(value) {
    return [...String(value).matchAll(/[\p{L}\p{N}]+/gu)].map((match) => ({
      value: fold(match[0]),
      raw: match[0],
      start: match.index,
      end: match.index + match[0].length,
    }));
  }
  function singular(value) {
    if (value.length < 5 || /(?:ss|us|is)$/.test(value)) return value;
    if (value.endsWith("ies")) return value.slice(0, -3) + "y";
    return value.endsWith("s") ? value.slice(0, -1) : value;
  }
  function variants(term, detail) {
    const items = [{ text: term, canonical: true }];
    function add(value) {
      if (typeof value === "string" && value.trim())
        items.push({ text: value });
      else if (Array.isArray(value)) value.forEach(add);
      else if (value && typeof value === "object")
        add(value.text || value.matched_text || value.surface || value.name);
    }
    for (const key of [
      "aliases",
      "synonyms",
      "mentions",
      "surface_forms",
      "matched_text",
      "text",
      "occurrences",
    ])
      add(detail[key]);
    if (detail.kind === "medical" && term.includes(",")) {
      const [main, ...qualifiers] = term.split(",").map((part) => part.trim());
      add([...qualifiers, main].join(" "));
      if (qualifiers.every((part) => /^human$/i.test(part))) add(main);
    }
    if (detail.kind === "entities_persons")
      add(term.replace(/^(?:(?:dr|prof|professor|mr|mrs|ms)\.?\s+)+/i, ""));
    if (detail.kind === "entities_locations" && words(term).length >= 3)
      add(term.replace(/\s+city$/i, ""));
    if (
      ["entities_organizations", "entities_locations"].includes(detail.kind)
    ) {
      const significant = words(term).filter(
        (word) => !["of", "the", "and", "for"].includes(word.value),
      );
      const acronym = significant
        .map((word) => word.raw[0])
        .join("")
        .toUpperCase();
      if (significant.length >= 2 && acronym.length <= 6)
        items.push({ text: acronym, uppercase: true });
    }
    const seen = new Set();
    return items.filter((item) => {
      item.tokens = words(item.text).map((word) => word.value);
      const key = item.tokens.join(" ") + Boolean(item.uppercase);
      if (!item.tokens.length || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  globalThis.vitalFindMention = (root, term, detail = {}) => {
    if (!root || !term?.trim()) return { found: false, count: 0 };
    const nodes = [],
      starts = [];
    let text = "",
      previousBlock = null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const current = walker.currentNode;
      if (!current.parentElement || current.parentElement.closest(excluded))
        continue;
      const block = current.parentElement.closest(
        "p,li,h1,h2,h3,h4,blockquote",
      );
      if (previousBlock && block && previousBlock !== block) text += "\u2029";
      previousBlock = block || previousBlock;
      starts.push(text.length);
      nodes.push(current);
      text += current.textContent;
    }
    const tokens = words(text),
      found = new Map();
    for (const variant of variants(term, detail || {})) {
      for (let i = 0; i <= tokens.length - variant.tokens.length; i++) {
        const selected = tokens.slice(i, i + variant.tokens.length);
        if (
          variant.uppercase &&
          selected.some((word) => word.raw !== word.raw.toUpperCase())
        )
          continue;
        const literal = selected.every(
          (word, j) => word.value === variant.tokens[j],
        );
        const inflected =
          !literal &&
          selected.every(
            (word, j) => singular(word.value) === singular(variant.tokens[j]),
          );
        if (!literal && !inflected) continue;
        const start = selected[0].start,
          end = selected.at(-1).end;
        if (text.slice(start, end).includes("\u2029")) continue;
        const key = `${start}:${end}`;
        if (!found.has(key))
          found.set(key, {
            start,
            end,
            matchType: variant.canonical && literal ? "exact" : "variant",
          });
      }
    }
    const ordered = [...found.values()].sort(
      (a, b) => a.start - b.start || b.end - a.end,
    );
    const matches = [];
    for (const match of ordered) {
      if (!matches.length || match.start >= matches.at(-1).end)
        matches.push(match);
    }
    if (!matches.length) return { found: false, count: 0 };
    const key = location.href + ":" + term;
    lastIndex = key === lastKey ? (lastIndex + 1) % matches.length : 0;
    lastKey = key;
    const match = matches[lastIndex];
    const startNode = starts.findLastIndex((value) => value <= match.start);
    const endNode = starts.findLastIndex((value) => value < match.end);
    const range = document.createRange();
    range.setStart(nodes[startNode], match.start - starts[startNode]);
    range.setEnd(nodes[endNode], match.end - starts[endNode]);
    nodes[startNode].parentElement.scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
    clearTimeout(timer);
    if (globalThis.CSS?.highlights && globalThis.Highlight) {
      CSS.highlights.set("vital-mention", new Highlight(range));
      timer = setTimeout(() => CSS.highlights.delete("vital-mention"), 2400);
    } else {
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      timer = setTimeout(() => {
        if (selection.rangeCount && selection.getRangeAt(0) === range)
          selection.removeAllRanges();
      }, 2400);
    }
    return {
      found: true,
      index: lastIndex + 1,
      count: matches.length,
      matchType: match.matchType,
      matchedText: range.toString(),
    };
  };
})();
