export const GATE_TYPES = new Set(['code', 'test', 'build', 'plan', 'visual', 'approval']);

export function evidenceIsFresh(evidence, headSha, changedFiles = []) {
  if (!evidence || evidence.headSha !== headSha) return false;
  if (!Array.isArray(evidence.fileScope) || evidence.fileScope.length === 0) return true;
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) return true;

  return !changedFiles.some((file) =>
    evidence.fileScope.some((scope) => {
      const prefix = scope.endsWith('/**') ? scope.slice(0, -3) : scope;
      return file === prefix || file.startsWith(`${prefix}/`);
    })
  );
}
