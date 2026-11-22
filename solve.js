// A fast drop-in replacement for csv-reader 1.0.0: run(input) returns exactly the reference's
// {columns, rows, errors} for every input, but reads with slice-based field extraction instead of
// one-character-at-a-time concatenation. Same broken-row policy, same error records, same order.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  const n = text.length;
  let pos = 0;
  let line = 1;
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  let recordLine = 1;
  let recordRow = null;

  // Reads unquoted characters starting at pos, seeded with `seed` (already-kept prefix).
  // Returns [value, ended, added] where added counts characters kept during this call only.
  function readUnquoted(seed) {
    let parts = null;
    let start = pos;
    let i = pos;
    let added = 0;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 44) { // ,
        added += i - start;
        pos = i + 1;
        const tail = text.slice(start, i);
        return [parts === null ? seed + tail : (parts.push(tail), parts.join('')), COMMA, added];
      }
      if (c === 10) { // \n
        added += i - start;
        pos = i + 1;
        line += 1;
        const tail = text.slice(start, i);
        return [parts === null ? seed + tail : (parts.push(tail), parts.join('')), LINE_BREAK, added];
      }
      if (c === 13) { // \r
        if (text.charCodeAt(i + 1) === 10) {
          added += i - start;
          pos = i + 2;
          line += 1;
          const tail = text.slice(start, i);
          return [parts === null ? seed + tail : (parts.push(tail), parts.join('')), LINE_BREAK, added];
        }
        // stray CR: dropped, error recorded against the record being read
        if (parts === null) parts = [seed];
        parts.push(text.slice(start, i));
        added += i - start;
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        i += 1;
        start = i;
        continue;
      }
      i += 1;
    }
    added += n - start;
    pos = n;
    const tail = text.slice(start, n);
    return [parts === null ? seed + tail : (parts.push(tail), parts.join('')), END, added];
  }

  // Reads a quoted field whose opening quote is at pos.
  // Returns [value, ended].
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let parts = null;
    let segStart = open + 1;
    let i = segStart;
    let closed = false;
    let closeAt = -1;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 34) { // "
        if (text.charCodeAt(i + 1) === 34) {
          if (parts === null) parts = [];
          parts.push(text.slice(segStart, i), '"');
          i += 2;
          segStart = i;
          continue;
        }
        closed = true;
        closeAt = i;
        i += 1;
        break;
      }
      if (c === 13) { // \r or \r\n inside quotes: one \n
        if (parts === null) parts = [];
        parts.push(text.slice(segStart, i), '\n');
        line += 1;
        i += text.charCodeAt(i + 1) === 10 ? 2 : 1;
        segStart = i;
        continue;
      }
      if (c === 10) line += 1;
      i += 1;
    }
    if (!closed) {
      pos = open + 1;
      line = openLine;
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      const r = readUnquoted('"');
      return [r[0], r[1]];
    }
    const value = parts === null
      ? text.slice(segStart, closeAt)
      : (parts.push(text.slice(segStart, closeAt)), parts.join(''));
    pos = i;
    if (pos >= n) return [value, END];
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      return [value, COMMA];
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      return [value, LINE_BREAK];
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      return [value, LINE_BREAK];
    }
    const junk = readUnquoted(value);
    if (junk[2] > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    return [junk[0], junk[1]];
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let ended;
    let quoted = false;
    do {
      quoted = text.charCodeAt(pos) === 34;
      const f = quoted ? readQuoted() : readUnquoted('');
      fields.push(f[0]);
      ended = f[1];
    } while (ended === COMMA);

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
