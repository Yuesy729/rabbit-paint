import type { ChatMsg } from '@/api/client';

/** 只在重试请求里附上校验错误,不保存到聊天或改动用户提示词。 */
export function formatRetryMessages(messages: ChatMsg[], attempt: number, error: string, review = false, comic = false): ChatMsg[] {
  if (!attempt || !error) return messages;
  return [...messages, {
    role: 'user',
    content: `上一次返回没有通过插件校验：${error.slice(0, 600)}。${!comic && review ? '请重新返回完整 scene_plan、每张图的 image_check 和最终 JSON,修正缺失项目及与实际tag不一致的引用。' : '请根据本请求既有输出协议重新返回完整的最终 JSON。'}${comic ? '漫画继续使用前文 pages/bonus 分镜协议，不切换成插画 images/tag 协议。' : '根级 images 与 changes 都使用数组；当前后端若要求 characters,该字段也使用数组。'}字段归属、张数和合法 P编号按前文任务要求执行。不要只返回单张图片对象、角色对象或旧格式文本。`,
  }];
}
