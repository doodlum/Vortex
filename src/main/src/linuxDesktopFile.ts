/** Desktop Entry string escaping and Exec quoting are separate decoding layers. */
export function desktopString(value: string): string {
  if (value.includes("\0")) throw new Error("A desktop field cannot contain NUL");
  return value
    .replace(/\\/g, "\\\\")
    .replace(/ /g, "\\s")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

// Characters the Desktop Entry Specification reserves in Exec; an argument holding one is quoted.
const RESERVED = /[\s"'\\><~|&;$*?#()`]/;

export function desktopArgument(value: string): string {
  // Others stay bare: xdg-mime's generic lookup takes Exec's first word literally and ignores a
  // default handler whose quoted executable it cannot find.
  if (value.length > 0 && !RESERVED.test(value)) return desktopString(value.replace(/%/g, "%%"));
  const quoted = value.replace(/(["`$\\])/g, "\\$1").replace(/%/g, "%%");
  return `"${desktopString(quoted)}"`;
}

export function desktopCommand(command: readonly string[], uri = false): string {
  if (!command[0]) throw new Error("A desktop command needs an executable");
  return command.map(desktopArgument).join(" ") + (uri ? " %u" : "");
}

export function desktopFields(contents: string): Record<string, string> {
  let active = false;
  const result: Record<string, string> = {};
  for (const raw of contents.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[")) {
      active = line === "[Desktop Entry]";
      continue;
    }
    if (!active) continue;
    const index = line.indexOf("=");
    if (index <= 0) continue;
    const key = line.slice(0, index);
    if (!/^[A-Za-z0-9-]+$/.test(key)) continue;
    if (Object.hasOwn(result, key)) throw new Error(`Duplicate desktop field: ${key}`);
    result[key] = line.slice(index + 1);
  }
  return result;
}

export function desktopValue(value: string): string {
  return value.replace(/\\([sntr\\])/g, (_match, code: string) => {
    return (
      ({ s: " ", n: "\n", t: "\t", r: "\r", "\\": "\\" } as Record<string, string>)[code] ?? code
    );
  });
}

/** Read Exec tokens without shell expansion; preserve field-code tokens for validation. */
export function desktopArguments(value: string): string[] {
  const input = desktopValue(value);
  const result: string[] = [];
  let token = "",
    quoted = false,
    started = false;
  for (let index = 0; index < input.length; index++) {
    const character = input[index];
    if (character === '"') {
      quoted = !quoted;
      started = true;
    } else if (character === "\\" && quoted) {
      const next = input[++index];
      if (next === undefined || !['"', "`", "$", "\\"].includes(next))
        throw new Error("Invalid desktop Exec escape");
      token += next;
      started = true;
    } else if (character !== undefined && /\s/.test(character) && !quoted) {
      if (started) {
        result.push(token.replace(/%%/g, "%"));
        token = "";
        started = false;
      }
    } else {
      token += character;
      started = true;
    }
  }
  if (quoted) throw new Error("Unclosed desktop Exec quote");
  if (started) result.push(token.replace(/%%/g, "%"));
  return result;
}

/** Only unquoted standalone URI field codes can accept a remote scheme URI. */
export function desktopAcceptsUris(fields: Record<string, string>): boolean {
  if (
    fields.Type !== "Application" ||
    fields.Hidden === "true" ||
    !(fields.MimeType ?? "").split(";").includes("x-scheme-handler/nxm")
  )
    return false;
  const input = desktopValue(fields.Exec ?? "");
  let token = "",
    quoted = false,
    hadQuotes = false;
  const placeholders: string[] = [];
  let activeFileCodes = 0;
  function finish(): void {
    if (!hadQuotes && /^%[fFuU]$/.test(token)) placeholders.push(token);
    token = "";
    hadQuotes = false;
  }
  for (let index = 0; index < input.length; index++) {
    const character = input[index];
    // %% is a literal percent even inside a quoted argument. Other file/URI
    // macros remain active wherever they occur, including embedded/quoted ones.
    if (character === "%") {
      const code = input[index + 1];
      if (code === "%") {
        token += "%%";
        index++;
        continue;
      }
      if (!code || !"fFuUick".includes(code)) return false;
      if ("fFuU".includes(code)) activeFileCodes++;
    }
    if (character === '"') {
      quoted = !quoted;
      hadQuotes = true;
    } else if (character === "\\" && quoted) {
      const next = input[++index];
      if (next === undefined || !['"', "`", "$", "\\"].includes(next)) return false;
      token += character + next;
    } else if (character !== undefined && /\s/.test(character) && !quoted) finish();
    else token += character;
  }
  finish();
  return (
    !quoted &&
    activeFileCodes === 1 &&
    placeholders.length === 1 &&
    /^%[uU]$/.test(placeholders[0]!)
  );
}
