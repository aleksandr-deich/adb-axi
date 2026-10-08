import { AdbAxiError } from "../../core/errors.js";

/**
 * The statement kinds `data db` runs. Every one only reads: `WITH` can still lead into a
 * write, which the read-only connection then refuses. What is kept out early, before
 * anything touches the device, includes statement kinds that could reach a host file
 * (`VACUUM INTO`, `ATTACH`) and sqlite3 shell dot-commands (`.shell`, `.output`, ...), which
 * are not SQL.
 */
const READ_KEYWORDS = new Set(["SELECT", "WITH", "VALUES", "EXPLAIN", "PRAGMA"]);

/**
 * Accept exactly one statement that starts with a reading keyword, or refuse it with a
 * `VALIDATION_ERROR` before anything touches the device. Comments, quoted text and
 * brackets are skipped, so a `;` or `.` inside them does not start a new statement.
 */
export function assertReadOnlySql(sql: string): void {
  const heads = statementHeads(sql);
  if (heads.length === 0) {
    throw new AdbAxiError("VALIDATION_ERROR", "the SQL is empty", {
      help: ["Pass one statement, for example `SELECT name, sql FROM sqlite_master`"],
    });
  }
  if (heads.length > 1) {
    throw new AdbAxiError(
      "VALIDATION_ERROR",
      `the SQL has ${heads.length} statements; data db runs one at a time`,
      { help: ["Run each statement as its own command"] },
    );
  }
  const [head = ""] = heads;
  if (READ_KEYWORDS.has(head.toUpperCase())) return;
  const what = head.startsWith(".")
    ? "sqlite3 dot-commands are not accepted"
    : `${/^[A-Za-z]+$/.test(head) ? head.toUpperCase() : head} is not a read; the copy is read-only`;
  throw new AdbAxiError("VALIDATION_ERROR", `data db only reads: ${what}`, {
    help: [
      "Use SELECT, WITH, VALUES, EXPLAIN or PRAGMA; for the schema, `SELECT name, sql FROM sqlite_master`",
    ],
  });
}

/** The first word of every non-empty statement, with comments and quoted text skipped. */
export function statementHeads(sql: string): string[] {
  const heads: string[] = [];
  let head: string | undefined;
  let i = 0;
  while (i < sql.length) {
    const char = sql.charAt(i);
    const next = sql.charAt(i + 1);
    if (char === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end + 1;
    } else if (char === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
    } else if (/\s/.test(char)) {
      i++;
    } else if (char === ";") {
      if (head !== undefined) heads.push(head);
      head = undefined;
      i++;
    } else {
      const starts = head === undefined;
      head ??= /^[A-Za-z]+/.exec(sql.slice(i))?.[0] ?? char;
      i = skipQuoted(sql, i) ?? i + (starts ? head.length : 1);
    }
  }
  if (head !== undefined) heads.push(head);
  return heads;
}

/** Past the quoted text or bracketed name that starts at `i`; `undefined` when none does. */
function skipQuoted(sql: string, i: number): number | undefined {
  const char = sql.charAt(i);
  const close = char === "[" ? "]" : char === "'" || char === '"' || char === "`" ? char : "";
  if (close === "") return undefined;
  // A doubled quote is an escaped quote inside the text; brackets have no escape.
  let j = i + 1;
  while (j < sql.length) {
    if (sql.charAt(j) !== close) j++;
    else if (close !== "]" && sql.charAt(j + 1) === close) j += 2;
    else return j + 1;
  }
  return sql.length;
}
