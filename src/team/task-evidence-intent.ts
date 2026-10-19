const COURTESY_PREFIX = /^(?:(?:please|can you|could you|would you|help me)\s+)*/i;
const ANALYSIS_PREFIX = /^(?:analy(?:se|ze)|audit|assess|evaluate|explore|investigate|research|review|study|summari(?:s|z)e)\b/i;

function isAnalysisDeliverable(clause: string): boolean {
  return /^(?:add|build|create|edit|improve|make|update|write)\b/i.test(clause)
    && /(?:^|\s)(?:reports?|summar(?:y|ies)|findings|recommendations)[.!?]?\s*$/i.test(clause.split(/\b(?:with|without|of|on|for|in|to|that)\b/i)[0]);
}

export function inferTaskEvidenceIntent(...fields: string[]): { codeChangeRequested: boolean; analysisOnly: boolean } {
  const texts = fields.map(field => field.trim().replace(COURTESY_PREFIX, ''));
  // Keep field boundaries: an analysis subject must not hide a coding description.
  const clauses = texts.flatMap(text => text.split(/[,;:\r\n]|[.!?](?=\s)|\b(?:and|then|also)\b/i))
    .map(part => part.trim().replace(COURTESY_PREFIX, ''));
  const codeChangeRequested = clauses.some(clause => !isAnalysisDeliverable(clause)
    && /^(?:add|adjust|build|change|convert|correct|create|delete|edit|enhance|extend|fix|implement|improve|integrate|make|migrate|modify|optimi[sz]e|patch|port|refactor|remove|rename|repair|replace|resolve|rewrite|ship|simplify|support|tune|update|upgrade|wire|write)\b/i.test(clause));
  return {
    codeChangeRequested,
    analysisOnly: !codeChangeRequested && (texts.some(text => ANALYSIS_PREFIX.test(text)) || clauses.some(isAnalysisDeliverable)),
  };
}
