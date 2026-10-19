const COURTESY_PREFIX = /^(?:(?:please|can you|could you|would you|help me|only|just)\s+)*/i;
const EXPLANATION_PREFIX = /^(?:explain|describe|what|why|how|where|which|when|who)\b/i;
const MUTATION_PREFIX = /^(?:add(?:ing)?|apply(?:ing)?|adjust(?:ing)?|build(?:ing)?|chang(?:e|ing)|convert(?:ing)?|correct(?:ing)?|creat(?:e|ing)|delet(?:e|ing)|edit(?:ing)?|enhanc(?:e|ing)|extend(?:ing)?|fix(?:ing)?|implement(?:ing)?|improv(?:e|ing)|integrat(?:e|ing)|mak(?:e|ing)|migrat(?:e|ing)|modify(?:ing)?|optimi[sz](?:e|ing)|patch(?:ing)?|port(?:ing)?|refactor(?:ing)?|remov(?:e|ing)|renam(?:e|ing)|repair(?:ing)?|replac(?:e|ing)|resolv(?:e|ing)|rewrit(?:e|ing)|ship(?:ping)?|simplify(?:ing)?|support(?:ing)?|touch(?:ing)?|tun(?:e|ing)|updat(?:e|ing)|upgrad(?:e|ing)|wir(?:e|ing)|writ(?:e|ing))\b/i;
const LOCALIZED_MUTATION = /(?:구현|추가|수정|업데이트|지원|해결)(?!(?:하는|할|한|된)?\s*(?:방법|여부|이력|내역|계획|없이|안\s)|하지\s*(?:말|않))(?=$|[\s.!?]|해|하)/;
const NO_CHANGE_PREFIX = /^(?:do\s+not|don't|never)\s+/i;
const ANALYSIS_PREFIX = /^(?:analy(?:se|ze)|audit|assess|evaluate|explore|investigate|research|review|study|explain|describe|compare|outline|what|why|how|where|which|when|who|summari(?:s|z)e)\b/i;

export const QUOTED_LITERAL = /(["`])([\s\S]*?)\1|(?<!\w)'([^']*)'(?!\w)/g;
const COMMAND_BOUNDARY = /[;\r\n]|[.!?](?=\s)|,\s*(?:(?:and|but)\s+)?(?:then|also)\s+|(?:,\s*(?:(?:and|but)\s+)?|\b(?:and|but)\s+)(?=(?:please|can you|could you|would you|help me|only|just)\s)/i;

function normalizeClause(text: string): string {
  return text.trim().replace(COURTESY_PREFIX, '')
    .replace(/^(?:(?:task|step|phase|part)(?:\s+[\w-]+)?\s*:\s*)+/i, '')
    .replace(COURTESY_PREFIX, '')
    .replace(/\b(to|into|in|at|as)\s*:(?!\s*(?:[-*•]|\d+[.)])\s)\s*/gi, '$1 ');
}

function evaluatesOptions(text: string): boolean {
  return ANALYSIS_PREFIX.test(text) && /\b(?:options?|alternatives?|candidates?|choices?|approaches?)\s*:/i.test(text);
}

function splitCommands(text: string, optionList = false): string[] {
  return text.split(COMMAND_BOUNDARY).flatMap(clause => {
    if (optionList || evaluatesOptions(normalizeClause(clause))) return [clause];
    // Bare contrasts can share the question's subject rather than introduce a command.
    const boundary = /^(?:what|why|how|where|which|when|who)\b|^explain\s+why\b|\b(?:I|we|you|they)\b/i.test(normalizeClause(clause.split(/\bbut\b/i)[0]))
      ? /,\s*but\s+(?!\w+ing\b)/i : /(?:,\s*|\s+)but\s+(?!\w+ing\b)/i;
    return clause.split(boundary);
  });
}

function describesActions(text: string): boolean {
  if (/^(?:what|why|how|where|which|when|who)\b/i.test(text)) return true;
  if (evaluatesOptions(text)) return true;
  if (ANALYSIS_PREFIX.test(text) && /\b(?:how|whether)\s+to\b/i.test(text)) return true;
  return EXPLANATION_PREFIX.test(text)
    && [...text.matchAll(/\b(?:to|of|about|before|after|while)\s+/gi)]
      .some(match => MUTATION_PREFIX.test(text.slice(match.index! + match[0].length)));
}

function namesOutputFile(clause: string): boolean {
  return [...clause.matchAll(/\b(to|into|in|at|as)\s+(?:(?:the|a)\s+)?(?:((?:[\w-]+\s+){0,2}file\b)(?:\s+(?:named|called))?\s*)?(?:"([^"]+)"|'([^']+)'|`([^`]+)`|([^\s`"']+))?/gi)]
    .some(match => {
      const [, preposition, file, doubleQuoted, singleQuoted, backtickQuoted, token] = match;
      const explicitFile = Boolean(file);
      const context = clause.slice(0, match.index);
      const noFileChanges = /\bwithout\s+(?:changing|modifying|editing|touching)\s+(?:(?:any|the)\s+)?files?\b/i.test(clause);
      const sourceContext = noFileChanges ? context : context.split(/\bfor\b/i).at(-1) ?? '';
      if ((!explicitFile || noFileChanges) && /^(?:in|at)$/i.test(preposition)
        && (/\b(?:about|on)\b/i.test(sourceContext)
          || ((noFileChanges || !/\bfor\b/i.test(context)) && /\bof\b/i.test(context)))) return false;
      const quoted = doubleQuoted ?? singleQuoted ?? backtickQuoted;
      const path = quoted === undefined ? token ?? '' : Buffer.from(quoted, 'hex').toString('utf8');
      return explicitFile || (!/^[a-z]+:\/\//i.test(path) && (/[\\/]/.test(path)
        || /\.[a-z\d]+[.!?]?$/i.test(path) || /^(?:README|LICENSE|COPYING|NOTICE|CHANGELOG|AUTHORS|CONTRIBUTING|Dockerfile|Makefile)[.!?]?$/i.test(path)));
    });
}

function isAnalysisDeliverable(clause: string): boolean {
  return !namesOutputFile(clause) && /^(?:add|build|create|edit|improve|make|update|write)\b/i.test(clause)
    && /(?:^|\s)(?:reports?|summar(?:y|ies)|findings|recommendations)[.!?]?\s*$/i.test(clause.split(/\b(?:with|without|of|on|about|for|in|to|that)\b/i)[0]);
}

export function inferTaskEvidenceIntent(...fields: string[]): { codeChangeRequested: boolean; analysisOnly: boolean } {
  const texts = fields.map(field => {
    // Keep literal delimiters opaque while splitting task instructions.
    const protectedField = field.replace(QUOTED_LITERAL, (_literal, quote: string | undefined, content: string | undefined, single: string | undefined) =>
      `${quote ?? "'"}${Buffer.from(content ?? single ?? '', 'utf8').toString('hex')}${quote ?? "'"}`);
    const text = normalizeClause(protectedField);
    const list = /:\s*(?:\r?\n\s*)?(?:[-*•]|\d+[.)])\s+/.exec(text);
    if ((!EXPLANATION_PREFIX.test(text) && !evaluatesOptions(text)) || !list) return text;
    // Listed steps are the explanation's object; a later unlisted command remains visible.
    return text.slice(0, list.index) + '\n' + text.slice(list.index + 1)
      .replace(/(?:^|\r?\n)\s*([-*•]|\d+[.)])\s+([^\r\n]*)/g, (_line, marker: string, content: string) => {
        let nextItem = /^\d/.test(marker) ? Number.parseInt(marker, 10) + 1 : 1;
        const prose = content.replace(/(?:^|\s)(\d+)[.)](?=\s)/g, (item, number: string, offset: number) => {
          if (Number(number) !== nextItem
            || /\b(?:version|release|revision|node|v)\s*$/i.test(content.slice(0, offset))) return item;
          nextItem += 1;
          return item.slice(0, -1) + ')';
        });
        return splitCommands(prose, evaluatesOptions(text)).slice(1)
          .filter(part => !/^\s*(?:and\s+)?(?:[-*•]|\d+[.)])\s+/.test(part)).join('\n');
      });
  });
  // Keep field boundaries: an analysis subject must not hide a coding description.
  const clauses = texts.flatMap(text => splitCommands(text))
    .flatMap(sentence => {
      const normalized = normalizeClause(sentence);
      const parts = EXPLANATION_PREFIX.test(normalized) ? [normalized]
        : normalized.split(/\b(?:before|after|while|in order to|so as to|then|also)\s+/i);
      return parts.flatMap(part => describesActions(part.trim()) ? [part] : part.split(/,|:(?![\\/])|\b(?:and|then|also)\b/i));
    })
    .flatMap(part => {
      const clause = normalizeClause(part.trim().replace(/^(?:[-*•]|\d+[.)])\s+/, ''));
      if (EXPLANATION_PREFIX.test(clause) || describesActions(clause)) return [clause];
      // Keep explanatory and negative context when exposing subordinate actions.
      const actions = [...clause.matchAll(/\bto\s+/gi)]
        .filter(match => !/\b(?:how|not|ways?)\s+$/i.test(clause.slice(0, match.index))
          && !/\b(?:without|not)\b[^,;.!?\r\n]*$/i.test(clause.slice(0, match.index)))
        .map(match => clause.slice(match.index! + match[0].length).trim().replace(COURTESY_PREFIX, ''));
      return [clause, ...actions];
    });
  const codeChangeRequested = clauses.some(clause => !EXPLANATION_PREFIX.test(clause) && !describesActions(clause) && !isAnalysisDeliverable(clause)
    && (MUTATION_PREFIX.test(clause) || LOCALIZED_MUTATION.test(clause)
      || (/^(?:sav(?:e|ing)|persist(?:ing)?|record(?:ing)?|stor(?:e|ing)|export(?:ing)?|append(?:ing)?)\b/i.test(clause) && namesOutputFile(clause))));
  return {
    codeChangeRequested,
    analysisOnly: !codeChangeRequested && (texts.some(text => ANALYSIS_PREFIX.test(text)) || clauses.some(clause => ANALYSIS_PREFIX.test(clause) || (NO_CHANGE_PREFIX.test(clause) && MUTATION_PREFIX.test(clause.replace(NO_CHANGE_PREFIX, ''))) || isAnalysisDeliverable(clause))),
  };
}
