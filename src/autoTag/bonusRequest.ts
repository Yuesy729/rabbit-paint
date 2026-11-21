import type { TargetSegment } from '@/autoTag/clean';
import { parseBonusPlan, type ImagePlan } from '@/autoTag/protocol';

/** 彩蛋独立重试。验证失败也计入失败历史,不会要求重跑已经成功的正文任务。 */
export async function requestBonusWithRetry(
  request: (attempt: number, validate: (raw: string) => void, previousError: string) => Promise<unknown>,
  segments: TargetSegment[],
  profile: { nl: boolean; naiCharPrompts: boolean; comic?: boolean },
  retries: number,
  signal: AbortSignal,
  enabled: () => boolean,
  validateReview?: (raw: string, plan: ImagePlan) => void,
): Promise<ImagePlan | null> {
  let lastError: unknown = new Error('彩蛋未返回');
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal.aborted) throw new DOMException('已取消', 'AbortError');
    if (!enabled()) return null;
    const result: { plan: ImagePlan | null } = { plan: null };
    try {
      await request(attempt + 1, raw => {
        const candidate = parseBonusPlan(raw, segments, profile);
        validateReview?.(raw, candidate);
        result.plan = candidate;
      }, attempt ? (lastError instanceof Error ? lastError.message : String(lastError)) : '');
      if (signal.aborted) throw new DOMException('已取消', 'AbortError');
      if (!enabled()) return null;
      if (!result.plan) throw new Error('彩蛋请求没有通过结果校验');
      return result.plan;
    } catch (error) {
      if (signal.aborted) throw error;
      lastError = error;
    }
  }
  throw lastError;
}
