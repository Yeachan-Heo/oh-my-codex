const COURTESY_PREFIX = /^(?:(?:please|can you|could you|would you|help me)\s+)*/i;
const EXPLANATION_PREFIX = /^(?:explain|describe|what|why|how|where|which|when|who)\b/i;
const MUTATION_PREFIX = /^(?:add(?:ing)?|adjust(?:ing)?|build(?:ing)?|chang(?:e|ing)|convert(?:ing)?|correct(?:ing)?|creat(?:e|ing)|delet(?:e|ing)|edit(?:ing)?|enhanc(?:e|ing)|extend(?:ing)?|fix(?:ing)?|implement(?:ing)?|improv(?:e|ing)|integrat(?:e|ing)|mak(?:e|ing)|migrat(?:e|ing)|modify(?:ing)?|optimi[sz](?:e|ing)|patch(?:ing)?|port(?:ing)?|refactor(?:ing)?|remov(?:e|ing)|renam(?:e|ing)|repair(?:ing)?|replac(?:e|ing)|resolv(?:e|ing)|rewrit(?:e|ing)|ship(?:ping)?|simplify(?:ing)?|support(?:ing)?|tun(?:e|ing)|updat(?:e|ing)|upgrad(?:e|ing)|wir(?:e|ing)|writ(?:e|ing))\b/i;
const LOCALIZED_MUTATION = /(?:구현|추가|수정|업데이트|지원|해결)(?!(?:하는|할|한|된)?\s*(?:방법|여부|이력|내역|계획|없이|안\s)|하지\s*(?:말|않))(?=$|[\s.!?]|해|하)/;
const ANALYSIS_PREFIX = /^(?:analy(?:se|ze)|audit|assess|evaluate|explore|investigate|research|review|study|explain|describe|compare|outline|what|why|how|where|which|when|who|summari(?:s|z)e)\b/i;

function describesActions(text: string): boolean {
  if (/^(?:what|why|how|where|which|when|who)\b/i.test(text)) return true;
  if (ANALYSIS_PREFIX.test(text) && /\b(?:how|whether)\s+to\b/i.test(text)) return true;
  return EXPLANATION_PREFIX.test(text)
    && [...text.matchAll(/\b(?:to|of|about|before|after|while)\s+/gi)]
      .some(match => MUTATION_PREFIX.test(text.slice(match.index! + match[0].length)));
}

function isAnalysisDeliverable(clause: string): boolean {
  return /^(?:add|build|create|edit|improve|make|update|write)\b/i.test(clause)
    && /(?:^|\s)(?:reports?|summar(?:y|ies)|findings|recommendations)[.!?]?\s*$/i.test(clause.split(/\b(?:with|without|of|on|for|in|to|that)\b/i)[0]);
}

export function inferTaskEvidenceIntent(...fields: string[]): { codeChangeRequested: boolean; analysisOnly: boolean } {
  const texts = fields.map(field => {
    const text = field.trim().replace(COURTESY_PREFIX, '');
    const list = /:\s*(?:\r?\n\s*)?(?:[-*•]|\d+[.)])\s+/.exec(text);
    if (!EXPLANATION_PREFIX.test(text) || !list) return text;
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
        return prose.split(/[.!?]\s+|;\s*|,\s*(?:and\s+)?(?:then|also)\s+/i).slice(1)
          .filter(part => !/^\s*(?:and\s+)?(?:[-*•]|\d+[.)])\s+/.test(part)).join('\n');
      });
  });
  // Keep field boundaries: an analysis subject must not hide a coding description.
  const clauses = texts.flatMap(text => text.split(/[;\r\n]|[.!?](?=\s)|,\s*(?:and\s+)?(?:then|also)\s+/i))
    .flatMap(sentence => {
      const normalized = sentence.trim().replace(COURTESY_PREFIX, '');
      const parts = EXPLANATION_PREFIX.test(normalized) ? [normalized]
        : normalized.split(/\b(?:before|after|while|in order to|so as to|then|also)\s+/i);
      return parts.flatMap(part => describesActions(part.trim()) ? [part] : part.split(/[,:]|\b(?:and|then|also)\b/i));
    })
    .flatMap(part => {
      const clause = part.trim().replace(/^(?:[-*•]|\d+[.)])\s+/, '').replace(COURTESY_PREFIX, '');
      if (EXPLANATION_PREFIX.test(clause) || describesActions(clause)) return [clause];
      // Keep explanatory and negative context when exposing subordinate actions.
      const actions = [...clause.matchAll(/\bto\s+/gi)]
        .filter(match => !/\b(?:how|not|ways?)\s+$/i.test(clause.slice(0, match.index))
          && !/\b(?:without|not)\b[^,;.!?\r\n]*$/i.test(clause.slice(0, match.index)))
        .map(match => clause.slice(match.index! + match[0].length).trim().replace(COURTESY_PREFIX, ''));
      return [clause, ...actions];
    });
  const codeChangeRequested = clauses.some(clause => !EXPLANATION_PREFIX.test(clause) && !describesActions(clause) && !isAnalysisDeliverable(clause)
    && (MUTATION_PREFIX.test(clause) || LOCALIZED_MUTATION.test(clause)));
  return {
    codeChangeRequested,
    analysisOnly: !codeChangeRequested && (texts.some(text => ANALYSIS_PREFIX.test(text)) || clauses.some(isAnalysisDeliverable)),
  };
}
