export type Cell = string | number | boolean | null;
export type Row = Record<string, Cell>;

/** sqlite3's `-json` output is not something adb-axi can read. */
export class SqliteJsonError extends Error {}

/**
 * Parse what `sqlite3 -json` prints: one `[{...},\n{...}]` array per result set, and
 * nothing at all for a statement that returns no rows. A reader of its own rather than
 * `JSON.parse`, for two reasons that would otherwise lose data silently: a result with
 * two columns of the same name (`SELECT a.id, b.id`) keeps both, the later ones renamed
 * `id_2`, `id_3`; and an integer beyond 2^53 stays exact, as a string.
 */
export function parseSqliteJson(text: string): Row[] {
  const reader = new Reader(text);
  const rows: Row[] = [];
  reader.skipSpace();
  while (!reader.done()) {
    reader.expect("[");
    reader.skipSpace();
    if (reader.peek() === "]") {
      reader.next();
    } else {
      for (;;) {
        rows.push(reader.object());
        reader.skipSpace();
        const separator = reader.next();
        if (separator === "]") break;
        if (separator !== ",") throw reader.fail("expected , or ]");
        reader.skipSpace();
      }
    }
    reader.skipSpace();
  }
  return rows;
}

class Reader {
  private i = 0;

  constructor(private readonly text: string) {}

  done(): boolean {
    return this.i >= this.text.length;
  }

  peek(): string {
    return this.text.charAt(this.i);
  }

  next(): string {
    return this.text.charAt(this.i++);
  }

  skipSpace(): void {
    while (/\s/.test(this.peek())) this.i++;
  }

  expect(char: string): void {
    if (this.next() !== char) throw this.fail(`expected ${char}`);
  }

  fail(message: string): SqliteJsonError {
    return new SqliteJsonError(`${message} at offset ${this.i}`);
  }

  object(): Row {
    this.expect("{");
    const row: Row = {};
    this.skipSpace();
    if (this.peek() === "}") {
      this.next();
      return row;
    }
    for (;;) {
      this.skipSpace();
      const name = this.string();
      this.skipSpace();
      this.expect(":");
      this.skipSpace();
      // `defineProperty`, because a column named `__proto__` must stay a column.
      Object.defineProperty(row, uniqueName(row, name), {
        value: this.value(),
        enumerable: true,
        writable: true,
        configurable: true,
      });
      this.skipSpace();
      const separator = this.next();
      if (separator === "}") return row;
      if (separator !== ",") throw this.fail("expected , or }");
    }
  }

  private value(): Cell {
    if (this.peek() === '"') return this.string();
    const start = this.i;
    while (!/[\s,}\]]/.test(this.peek()) && !this.done()) this.i++;
    const token = this.text.slice(start, this.i);
    if (token === "") throw this.fail("expected a value");
    if (token === "null") return null;
    if (token === "true") return true;
    if (token === "false") return false;
    if (/^-?\d+$/.test(token)) return Number.isSafeInteger(Number(token)) ? Number(token) : token;
    if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(token)) return Number(token);
    // Not JSON (`Inf`, `NaN`): kept as the text sqlite3 printed.
    return token;
  }

  private string(): string {
    this.expect('"');
    let out = "";
    for (;;) {
      if (this.done()) throw this.fail("unterminated string");
      const char = this.next();
      if (char === '"') return out;
      if (char !== "\\") {
        out += char;
        continue;
      }
      const escape = this.next();
      if (escape === "u") {
        const hex = this.text.slice(this.i, this.i + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw this.fail("bad \\u escape");
        out += String.fromCharCode(Number.parseInt(hex, 16));
        this.i += 4;
        continue;
      }
      const simple: Record<string, string> = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
      out += simple[escape] ?? escape;
    }
  }
}

function uniqueName(row: Row, name: string): string {
  if (!Object.hasOwn(row, name)) return name;
  for (let n = 2; ; n++) {
    const candidate = `${name}_${n}`;
    if (!Object.hasOwn(row, candidate)) return candidate;
  }
}
