// A small parser for the JavaScript literals the recorder writes into generated
// code: strings, numbers, booleans, objects, arrays and regular expressions.
//
// The alternative — rewriting the source into JSON with regexes — breaks on the
// first apostrophe in a button label, which is exactly the input this has to
// survive. A regex literal becomes { regex, flags }, since JSON has no literal
// for one and that is the shape the locator resolver reads.

/** A regular expression recovered from generated code. */
export interface RegexLiteral {
  regex: string;
  flags?: string;
}

export class LiteralParseError extends Error {}

/** Parse a comma-separated argument list (the text between one call's parens). */
export function parseArgs(source: string): unknown[] {
  const p = new Parser(source);
  const args: unknown[] = [];
  p.skipSpace();
  if (p.atEnd()) return args;
  for (;;) {
    args.push(p.parseValue());
    p.skipSpace();
    if (p.atEnd()) break;
    if (p.peek() === ",") {
      p.next();
      p.skipSpace();
      if (p.atEnd()) break; // trailing comma
      continue;
    }
    throw new LiteralParseError(`unexpected ${JSON.stringify(p.peek())} at ${p.position()} in ${JSON.stringify(source)}`);
  }
  return args;
}

class Parser {
  private i = 0;
  constructor(private readonly src: string) {}

  atEnd(): boolean {
    return this.i >= this.src.length;
  }
  peek(): string {
    return this.src[this.i] ?? "";
  }
  next(): string {
    return this.src[this.i++] ?? "";
  }
  position(): number {
    return this.i;
  }

  skipSpace(): void {
    while (!this.atEnd() && /\s/.test(this.peek())) this.i++;
  }

  parseValue(): unknown {
    this.skipSpace();
    const c = this.peek();
    if (c === "'" || c === '"' || c === "`") return this.parseString();
    if (c === "{") return this.parseObject();
    if (c === "[") return this.parseArray();
    if (c === "/") return this.parseRegex();
    return this.parseWord();
  }

  private parseString(): string {
    const quote = this.next();
    let out = "";
    while (!this.atEnd()) {
      const c = this.next();
      if (c === "\\") {
        out += unescape_(this.next());
        continue;
      }
      if (c === quote) return out;
      out += c;
    }
    throw new LiteralParseError("unterminated string");
  }

  private parseRegex(): RegexLiteral {
    this.next(); // opening /
    let source = "";
    let inClass = false;
    while (!this.atEnd()) {
      const c = this.next();
      if (c === "\\") {
        source += c + this.next();
        continue;
      }
      if (c === "[") inClass = true;
      else if (c === "]") inClass = false;
      else if (c === "/" && !inClass) {
        let flags = "";
        while (!this.atEnd() && /[a-z]/.test(this.peek())) flags += this.next();
        return flags === "" ? { regex: source } : { regex: source, flags };
      }
      source += c;
    }
    throw new LiteralParseError("unterminated regular expression");
  }

  private parseObject(): Record<string, unknown> {
    this.next(); // {
    const out: Record<string, unknown> = {};
    this.skipSpace();
    if (this.peek() === "}") {
      this.next();
      return out;
    }
    for (;;) {
      this.skipSpace();
      const key = this.peek() === "'" || this.peek() === '"' || this.peek() === "`" ? this.parseString() : this.parseKey();
      this.skipSpace();
      if (this.next() !== ":") throw new LiteralParseError(`expected ":" after key ${JSON.stringify(key)}`);
      out[key] = this.parseValue();
      this.skipSpace();
      const c = this.next();
      if (c === "}") return out;
      if (c !== ",") throw new LiteralParseError(`expected "," or "}" in object, found ${JSON.stringify(c)}`);
      this.skipSpace();
      if (this.peek() === "}") {
        this.next();
        return out;
      }
    }
  }

  private parseArray(): unknown[] {
    this.next(); // [
    const out: unknown[] = [];
    this.skipSpace();
    if (this.peek() === "]") {
      this.next();
      return out;
    }
    for (;;) {
      out.push(this.parseValue());
      this.skipSpace();
      const c = this.next();
      if (c === "]") return out;
      if (c !== ",") throw new LiteralParseError(`expected "," or "]" in array, found ${JSON.stringify(c)}`);
      this.skipSpace();
      if (this.peek() === "]") {
        this.next();
        return out;
      }
    }
  }

  private parseKey(): string {
    let key = "";
    while (!this.atEnd() && /[\w$]/.test(this.peek())) key += this.next();
    if (key === "") throw new LiteralParseError(`expected an object key at ${this.i}`);
    return key;
  }

  // parseWord covers numbers, the bare keywords, and any other expression the
  // recorder wrote (a nested locator in filter({ has: … }), say). Parens and
  // quotes inside are consumed so the expression comes back whole and the caller
  // can report it by name instead of failing to parse the line at all.
  private parseWord(): unknown {
    let word = "";
    let depth = 0;
    let quote = "";
    while (!this.atEnd()) {
      const c = this.peek();
      if (quote !== "") {
        word += this.next();
        if (c === "\\") word += this.next();
        else if (c === quote) quote = "";
        continue;
      }
      if (c === "'" || c === '"' || c === "`") {
        quote = c;
        word += this.next();
        continue;
      }
      if (c === "(" || c === "[") depth++;
      if (c === ")" || c === "]") {
        if (depth === 0) break;
        depth--;
      }
      if (depth === 0 && (c === "," || c === "}" || /\s/.test(c))) break;
      word += this.next();
    }
    word = word.trim();
    if (word === "") throw new LiteralParseError(`expected a value at ${this.i}`);
    if (word === "true") return true;
    if (word === "false") return false;
    if (word === "null") return null;
    if (word === "undefined") return undefined;
    const n = Number(word);
    if (Number.isFinite(n)) return n;
    // An identifier or expression: kept as text so the caller can report it
    // rather than inventing a value.
    return { expression: word };
  }
}

function unescape_(c: string): string {
  switch (c) {
    case "n":
      return "\n";
    case "t":
      return "\t";
    case "r":
      return "\r";
    case "b":
      return "\b";
    case "f":
      return "\f";
    case "v":
      return "\v";
    case "0":
      return "\0";
    default:
      return c; // \\ \' \" \` and anything else is itself
  }
}
