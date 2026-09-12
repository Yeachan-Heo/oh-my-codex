type TomlSourceStringMode =
  | "basic"
  | "literal"
  | "multiline-basic"
  | "multiline-literal";

export interface TomlSourceLexicalAnalysis {
  lines: string[];
  lineStartsOutsideMultiline: boolean[];
  lineHasTomlComment: boolean[];
  isUnambiguous: boolean;
}

function isMultilineTomlString(mode: TomlSourceStringMode | undefined): boolean {
  return mode === "multiline-basic" || mode === "multiline-literal";
}

/**
 * Tracks only lexical boundaries needed to safely associate source lines with
 * TOML statements. TOML's parser gives us semantics; this prevents source
 * repair from treating table-like text in a multiline value as syntax.
 */
export function analyzeTomlSource(config: string): TomlSourceLexicalAnalysis {
  const lines = config.split(/\r?\n/);
  const lineStartsOutsideMultiline: boolean[] = [];
  const lineHasTomlComment: boolean[] = [];
  let mode: TomlSourceStringMode | undefined;
  let isUnambiguous = true;

  for (const line of lines) {
    lineStartsOutsideMultiline.push(!isMultilineTomlString(mode));
    let hasComment = false;

    for (let index = 0; index < line.length; index += 1) {
      const character = line[index]!;
      if (mode === "basic") {
        if (character === "\\") {
          index += 1;
        } else if (character === "\"") {
          mode = undefined;
        }
        continue;
      }
      if (mode === "literal") {
        if (character === "'") mode = undefined;
        continue;
      }
      if (mode === "multiline-basic" || mode === "multiline-literal") {
        const delimiter = mode === "multiline-basic" ? "\"" : "'";
        if (mode === "multiline-basic" && character === "\\") {
          index += 1;
          continue;
        }
        if (character !== delimiter) continue;

        let runEnd = index + 1;
        while (line[runEnd] === delimiter) runEnd += 1;
        if (runEnd - index >= 3) {
          // TOML permits one or two delimiter characters immediately before
          // the closing triple delimiter as string content.
          mode = undefined;
          index = runEnd - 1;
        }
        continue;
      }

      if (character === "#") {
        hasComment = true;
        break;
      }
      if (character !== "\"" && character !== "'") continue;

      const isMultiline =
        line[index + 1] === character && line[index + 2] === character;
      if (isMultiline) {
        mode = character === "\"" ? "multiline-basic" : "multiline-literal";
        index += 2;
      } else {
        mode = character === "\"" ? "basic" : "literal";
      }
    }

    lineHasTomlComment.push(hasComment);
    if (mode === "basic" || mode === "literal") isUnambiguous = false;
  }

  if (isMultilineTomlString(mode)) isUnambiguous = false;
  return { lines, lineStartsOutsideMultiline, lineHasTomlComment, isUnambiguous };
}
