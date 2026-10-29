/** Explicit requests for prior states/change trails, not incidental past references.
 * Callers must pass only the latest direct user's text, never conversation context.
 */
export function wantsHistory(query) {
  const text = String(query ?? '').normalize('NFKC').replace(/```[\s\S]*?```/g, ' ').trim();
  const clauses = text.split(/[，,。！？!?;；\n]+/).filter(Boolean);
  return clauses.some((clause) => {
    // A negated lookup is not permission to fetch old versions.
    const q = clause.replace(/(?:不用|不必|不要|别|无需)[^，,]{0,12}(?:历史|以前|过去|旧版|旧要求)[^，,]*/g, '')
      .replace(/\b(?:don't|do not|no need to)\s+(?:show|fetch|recall|look up|include)[^,]*(?:history|previous|old|past)[^,]*/gi, '');
    if (/(?:怎么|如何|怎样|何时|什么时候).{0,18}(?:改过|改的|修改过|变更过|改变过|变化|演变)|(?:后来|之后).{0,8}(?:怎么|如何|怎样).{0,8}改|(?:变更|修改|变化|演变)(?:历史|过程|记录|轨迹)|(?:对比|比较).{0,30}(?:以前|之前|过去|原来|最初|旧|前后)|(?:以前|之前|过去|原来|最初).{0,25}(?:什么|哪些).{0,6}(?:区别|差异|不同|变化)/.test(q)
      || /\b(?:how|what|when)\b.{0,60}\b(?:changed|evolved|revised)\b|\b(?:how|when)\s+did\b.{0,60}\b(?:change|evolve)\b|\b(?:change (?:history|trail|log)|revision history|compare\b.{0,50}\b(?:previous|old|past|before))\b/i.test(q)) return true;
    if (/(?:回顾|追溯|查看|列出|看看|查一下).{0,20}(?:历史|旧版|旧要求|以前|过去)|(?:历史|旧版|旧要求).{0,12}(?:是什么|有哪些|怎样|如何)/.test(q)
      || /\b(?:show|list|recall|review|trace)\b.{0,50}\b(?:history|previous|old|past)\b/i.test(q)) return true;
    // Asking which rule applies now does not ask for its former versions.
    if (/(?:现在|目前|当前|如今).{0,25}(?:什么|怎么|如何|哪|多长|多少|要求|按|遵循)|(?:按什么|什么要求|哪个版本).{0,12}(?:现在|目前|当前)/.test(q)
      || /\b(?:current|currently|now|today)\b/i.test(q)) return false;
    if (/(?:之前|上次|以前)(?:说|提|讲|谈)(?:过)?的/.test(q)) return false;
    return /(?:以前|过去|之前|上次|曾经|原来|最初|当时|早先).{0,28}(?:什么|怎样|如何|多长|多少|哪些|哪种|怎么样)|(?:什么|怎样|如何|多长|多少|哪些).{0,28}(?:以前|过去|之前|上次|原来|最初|当时)/.test(q)
      || /\b(?:what|which|how)\b.{0,70}\b(?:previous(?:ly)?|formerly|used to|earlier|before|original(?:ly)?|past|last time)\b|\b(?:previously|formerly|earlier|before|originally|last time)\b.{0,70}\b(?:what|which|how)\b/i.test(q);
  });
}
