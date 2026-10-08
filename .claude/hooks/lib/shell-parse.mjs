// Minimal Bash/PowerShell tokenizer for the SYVEKA guardrail hooks.
//
// It is not a full shell parser. Its job is to recover the *simple commands* a
// script will run — including ones hidden inside $(...), backticks, process
// substitution, `bash -c "..."`, `pwsh -Command "..."`, heredocs fed to a shell,
// and string literals passed to inline interpreters — so the guards can inspect
// each one. Anything it can't confidently decode is reported via `opaque` so the
// caller can fail closed.

const MAX_DEPTH = 6;

/**
 * @typedef {{ op: string, target: string | null }} Redirect
 * @typedef {{
 *   words: string[],
 *   redirects: Redirect[],
 *   heredocs: string[],
 *   dialect: "bash" | "powershell",
 *   depth: number,
 * }} SimpleCommand
 * @typedef {{
 *   commands: SimpleCommand[],
 *   envReads: string[],
 *   envWrites: string[],
 *   opaque: string[],
 *   substitutions: string[],
 * }} ParseResult
 */

/** @returns {ParseResult} */
export function parseScript(source, dialect = "bash", depth = 0) {
  /** @type {ParseResult} */
  const result = { commands: [], envReads: [], envWrites: [], opaque: [], substitutions: [] };
  if (depth > MAX_DEPTH) {
    result.opaque.push("command nesting is deeper than the guard can inspect");
    return result;
  }
  const tokens = tokenize(String(source ?? ""), dialect, depth, result);
  groupCommands(tokens, dialect, depth, result);
  return result;
}

function mergeInto(target, nested) {
  target.commands.push(...nested.commands);
  target.envReads.push(...nested.envReads);
  target.envWrites.push(...nested.envWrites);
  target.opaque.push(...nested.opaque);
  target.substitutions.push(...nested.substitutions);
}

function readBalanced(src, start, open, close) {
  // src[start] is just after the opening delimiter; returns index of matching close.
  let level = 1;
  let i = start;
  let quote = null;
  while (i < src.length) {
    const ch = src[i];
    if (quote) {
      if (ch === "\\" && quote === '"') i++;
      else if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === "\\") {
      i++;
    } else if (ch === open) {
      level++;
    } else if (ch === close) {
      level--;
      if (level === 0) return i;
    }
    i++;
  }
  return -1;
}

function recordVariable(src, i, dialect, result) {
  // src[i] === "$". Records env reads/writes; returns number of chars consumed after "$".
  const rest = src.slice(i + 1);
  if (dialect === "powershell") {
    const m = /^(?:\{env:([A-Za-z_][A-Za-z0-9_]*)\}|env:([A-Za-z_][A-Za-z0-9_]*))/i.exec(rest);
    if (m) {
      const name = m[1] || m[2];
      const after = rest.slice(m[0].length);
      if (/^\s*=(?!=)/.test(after)) result.envWrites.push(name);
      else result.envReads.push(name);
      return m[0].length;
    }
    return 0;
  }
  const m = /^(?:\{[#!]?([A-Za-z_][A-Za-z0-9_]*)|([A-Za-z_][A-Za-z0-9_]*))/.exec(rest);
  if (m) {
    result.envReads.push(m[1] || m[2]);
    return 0; // keep the literal text in the word
  }
  return 0;
}

function tokenize(rawSrc, dialect, depth, result) {
  // PowerShell treats typographic quotes as ordinary quotes.
  const src =
    dialect === "powershell"
      ? rawSrc.replace(/[\u201C\u201D\u201E]/g, '"').replace(/[\u2018\u2019\u201A]/g, "'")
      : rawSrc;
  /** @type {Array<{t: "word", v: string} | {t: "op", v: string} | {t: "redir", v: string} | {t: "heredoc", v: string}>} */
  const tokens = [];
  let word = "";
  let inWord = false;
  const pendingHeredocs = [];
  const escapeChar = dialect === "powershell" ? "`" : "\\";

  const endWord = () => {
    if (inWord) tokens.push({ t: "word", v: word });
    word = "";
    inWord = false;
  };
  // Command substitutions run as commands of their own; their text is also kept so callers
  // can tell when a word's value is computed at run time.
  const nested = (text, d = dialect) => {
    result.substitutions.push(text);
    mergeInto(result, parseScript(text, d, depth + 1));
  };

  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];

    if (ch === "\n") {
      endWord();
      tokens.push({ t: "op", v: ";" });
      i++;
      // Consume heredoc bodies that start after this newline.
      while (pendingHeredocs.length) {
        const { delimiter, stripTabs } = pendingHeredocs.shift();
        const lines = [];
        let closed = false;
        while (i <= src.length) {
          const nl = src.indexOf("\n", i);
          const line = src.slice(i, nl === -1 ? src.length : nl);
          i = nl === -1 ? src.length + 1 : nl + 1;
          const cmp = stripTabs ? line.replace(/^\t+/, "") : line;
          if (cmp.replace(/\r$/, "") === delimiter) {
            closed = true;
            break;
          }
          lines.push(line);
          if (nl === -1) break;
        }
        if (i > src.length) i = src.length;
        tokens.push({ t: "heredoc", v: lines.join("\n") });
        if (!closed) break;
      }
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r") {
      endWord();
      i++;
      continue;
    }
    if (ch === "#" && !inWord) {
      const nl = src.indexOf("\n", i);
      i = nl === -1 ? src.length : nl;
      continue;
    }
    if (dialect === "powershell" && ch === "<" && next === "#") {
      const close = src.indexOf("#>", i + 2);
      i = close === -1 ? src.length : close + 2;
      continue;
    }
    if (ch === escapeChar) {
      if (next === "\n") {
        i += 2;
        continue;
      }
      if (next === "\r" && src[i + 2] === "\n") {
        i += 3;
        continue;
      }
      if (next !== undefined) {
        word += next;
        inWord = true;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (ch === "'") {
      let j = i + 1;
      let text = "";
      while (j < src.length) {
        if (src[j] === "'") {
          if (dialect === "powershell" && src[j + 1] === "'") {
            text += "'";
            j += 2;
            continue;
          }
          break;
        }
        text += src[j];
        j++;
      }
      word += text;
      inWord = true;
      i = j + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let text = "";
      while (j < src.length && src[j] !== '"') {
        const c = src[j];
        // In Bash double quotes a backslash only escapes $ ` " \ and newline, so
        // Windows paths like "C:\Users\x" keep their backslashes.
        if (
          c === escapeChar &&
          j + 1 < src.length &&
          (dialect === "powershell" || /[$`"\\\n]/.test(src[j + 1]))
        ) {
          text += src[j + 1];
          j += 2;
          continue;
        }
        if (dialect === "powershell" && c === '"' && src[j + 1] === '"') {
          text += '"';
          j += 2;
          continue;
        }
        if (c === "$" && src[j + 1] === "(") {
          const close = readBalanced(src, j + 2, "(", ")");
          if (close === -1) {
            result.opaque.push("unterminated $( ) substitution");
            j = src.length;
            break;
          }
          nested(src.slice(j + 2, close));
          text += "$(...)";
          j = close + 1;
          continue;
        }
        if (c === "`" && dialect === "bash") {
          const close = src.indexOf("`", j + 1);
          if (close === -1) {
            result.opaque.push("unterminated backtick substitution");
            j = src.length;
            break;
          }
          nested(src.slice(j + 1, close));
          text += "`...`";
          j = close + 1;
          continue;
        }
        if (c === "$") {
          j += 1 + recordVariable(src, j, dialect, result);
          text += c;
          continue;
        }
        text += c;
        j++;
      }
      word += text;
      inWord = true;
      i = j + 1;
      continue;
    }
    // Bash ANSI-C quoting: $'\x67it' is the literal word "git".
    if (dialect === "bash" && ch === "$" && next === "'") {
      let j = i + 2;
      let text = "";
      while (j < src.length && src[j] !== "'") {
        if (src[j] === "\\" && j + 1 < src.length) {
          const rest = src.slice(j + 1);
          const hex = /^x([0-9a-fA-F]{1,2})/.exec(rest);
          const uni = /^[uU]([0-9a-fA-F]{1,8})/.exec(rest);
          const oct = /^([0-7]{1,3})/.exec(rest);
          if (hex) {
            text += String.fromCharCode(parseInt(hex[1], 16));
            j += 1 + hex[0].length;
          } else if (uni) {
            text += String.fromCodePoint(parseInt(uni[1], 16));
            j += 1 + uni[0].length;
          } else if (oct) {
            text += String.fromCharCode(parseInt(oct[1], 8));
            j += 1 + oct[0].length;
          } else {
            const escapes = {
              n: "\n",
              t: "\t",
              r: "\r",
              a: "\x07",
              b: "\b",
              e: "\x1b",
              E: "\x1b",
              f: "\f",
              v: "\v",
            };
            text += escapes[rest[0]] ?? rest[0];
            j += 2;
          }
          continue;
        }
        text += src[j];
        j++;
      }
      word += text;
      inWord = true;
      i = j + 1;
      continue;
    }
    if (ch === "$" && next === "(") {
      const close = readBalanced(src, i + 2, "(", ")");
      if (close === -1) {
        result.opaque.push("unterminated $( ) substitution");
        break;
      }
      nested(src.slice(i + 2, close));
      word += "$(...)";
      inWord = true;
      i = close + 1;
      continue;
    }
    if (ch === "$") {
      const consumed = recordVariable(src, i, dialect, result);
      word += src.slice(i, i + 1 + consumed);
      inWord = true;
      i += 1 + consumed;
      continue;
    }
    if (ch === "`" && dialect === "bash") {
      const close = src.indexOf("`", i + 1);
      if (close === -1) {
        result.opaque.push("unterminated backtick substitution");
        break;
      }
      nested(src.slice(i + 1, close));
      word += "`...`";
      inWord = true;
      i = close + 1;
      continue;
    }
    if ((ch === "<" || ch === ">") && next === "(" && dialect === "bash") {
      const close = readBalanced(src, i + 2, "(", ")");
      if (close === -1) {
        result.opaque.push("unterminated process substitution");
        break;
      }
      nested(src.slice(i + 2, close));
      word += "<(...)";
      inWord = true;
      i = close + 1;
      continue;
    }
    // Redirections: [n]> [n]>> &> &>> *> >| < << <<- <<< n>&m
    if (ch === ">" || ch === "<" || ((ch === "&" || ch === "*") && next === ">")) {
      let op = "";
      if (inWord && /^\d+$/.test(word)) {
        op = word;
        word = "";
        inWord = false;
      } else {
        endWord();
      }
      let j = i;
      if (src[j] === "&" || src[j] === "*") op += src[j++];
      op += src[j++];
      while (src[j] === ">" || src[j] === "<" || src[j] === "|" || src[j] === "-") {
        if (src[j] === "-" && !op.endsWith("<<")) break;
        op += src[j++];
      }
      if (src[j] === "&" && /^\d|-/.test(src[j + 1] ?? "")) {
        // fd duplication like 2>&1 or >&- — no file target.
        j += 2;
        while (/\d/.test(src[j] ?? "")) j++;
        i = j;
        continue;
      }
      if ((op.endsWith("<<") || op.endsWith("<<-")) && !op.endsWith("<<<")) {
        const rest = src.slice(j);
        const m = /^\s*(['"]?)([A-Za-z_][A-Za-z0-9_-]*)\1/.exec(rest);
        if (m) {
          pendingHeredocs.push({ delimiter: m[2], stripTabs: op.endsWith("-") });
          i = j + m[0].length;
          continue;
        }
      }
      tokens.push({ t: "redir", v: op });
      i = j;
      continue;
    }
    // PowerShell script blocks ({ ... } after ForEach-Object, Where-Object, `& { }`, a
    // [scriptblock] variable, ...) contain commands, so braces separate commands there.
    const psBrace = dialect === "powershell" && (ch === "{" || ch === "}");
    if (psBrace || ch === "&" || ch === "|" || ch === ";" || ch === "(" || ch === ")") {
      endWord();
      if (
        (ch === "&" && next === "&") ||
        (ch === "|" && next === "|") ||
        (ch === "|" && next === "&")
      ) {
        tokens.push({ t: "op", v: ch + next });
        i += 2;
      } else {
        tokens.push({ t: "op", v: ch });
        i++;
      }
      continue;
    }
    word += ch;
    inWord = true;
    i++;
  }
  endWord();
  return tokens;
}

const KEYWORDS = new Set([
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "do",
  "done",
  "while",
  "until",
  "!",
  "{",
  "}",
  "time",
  "case",
  "esac",
  "in",
]);

function groupCommands(tokens, dialect, depth, result) {
  /** @type {SimpleCommand} */
  let current = { words: [], redirects: [], heredocs: [], dialect, depth, piped: false };
  let pendingRedirect = null;
  const flush = () => {
    if (pendingRedirect) current.redirects.push({ op: pendingRedirect, target: null });
    pendingRedirect = null;
    while (current.words.length && KEYWORDS.has(current.words[0])) current.words.shift();
    if (current.words.length || current.redirects.length) result.commands.push(current);
    current = { words: [], redirects: [], heredocs: [], dialect, depth, piped: false };
  };
  for (const token of tokens) {
    if (token.t === "op") {
      flush();
      // `piped` marks a command that reads the previous command's output.
      current.piped = token.v === "|" || token.v === "|&";
    } else if (token.t === "redir") {
      if (pendingRedirect) current.redirects.push({ op: pendingRedirect, target: null });
      pendingRedirect = token.v;
    } else if (token.t === "heredoc") {
      // Heredoc bodies arrive after the command's newline; attach to the last command.
      const last = result.commands[result.commands.length - 1];
      if (last) last.heredocs.push(token.v);
    } else if (pendingRedirect) {
      current.redirects.push({ op: pendingRedirect, target: token.v });
      pendingRedirect = null;
    } else {
      current.words.push(token.v);
    }
  }
  flush();
}

/** Extracts quoted string literals from inline interpreter code (node -e, python -c, ...). */
export function stringLiterals(code) {
  const literals = [];
  const re = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;
  let m;
  while ((m = re.exec(code))) literals.push((m[1] ?? m[2] ?? m[3] ?? "").replace(/\\(.)/g, "$1"));
  return literals;
}

/** Lower-cased command name without directory or Windows executable extension. */
export function commandName(word) {
  const base = String(word ?? "")
    .split(/[\\/]/)
    .pop()
    .toLowerCase();
  return base.replace(/\.(exe|cmd|bat|ps1|com)$/, "");
}
