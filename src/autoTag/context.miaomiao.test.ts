import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MIAOMIAO_SOURCE_TEXT } from '@/autoTag/worldbookPreset';
import { fetchWorldInfo } from '@/autoTag/context';

const mocks = vi.hoisted(() => ({ context: {} as any, check: vi.fn(), primary: true }));
vi.mock('@/st/context', async original => ({
  ...await original<any>(), getContext: () => mocks.context,
  getCheckWorldInfo: async () => mocks.primary ? mocks.check : null,
  getEjsTemplate: () => null,
}));

describe('融合模式避免旧世界书重复注入', () => {
  const sourceEntries = Object.values(JSON.parse(MIAOMIAO_SOURCE_TEXT).entries) as any[];
  const body = sourceEntries.find(item => item.comment === '主体').content;
  const chat = [{ name: 'Char', is_user: false, mes: '在咖啡店。' }] as any;

  beforeEach(() => {
    mocks.primary = true;
    mocks.context = { substituteParams: (text: string) => text };
    mocks.check.mockReset();
    mocks.check.mockResolvedValue({ allActivatedEntries: new Set([
      { world: '角色设定', uid: 1, comment: '人设', content: '角色有黑色头发。', order: 500 },
      { world: '喵喵', uid: 2, comment: '主体', content: body, order: 501 },
    ]) });
  });

  it('只在融合模式过滤完全匹配的参考绘图条目,其他设定和原书不改', async () => {
    const fused = await fetchWorldInfo(chat, [0], 'User', 'Char', true);
    expect(fused).toContain('角色有黑色头发。');
    expect(fused).not.toContain('image###');
    const normal = await fetchWorldInfo(chat, [0], 'User', 'Char', false);
    expect(normal).toContain('image###');
    expect(normal).toContain('角色有黑色头发。');
  });

  it('旧宿主降级路径也剔除可识别的完整旧任务块,保留周围设定', async () => {
    mocks.primary = false;
    mocks.context.getWorldInfoPrompt = vi.fn(async () => ({
      worldInfoBefore: '人物设定。\n<imageTag>\n了解组成\n多人交互逻辑\nimage###\n</imageTag>\n世界背景。',
    }));
    const fused = await fetchWorldInfo(chat, [0], 'User', 'Char', true);
    expect(fused).toContain('人物设定。');
    expect(fused).toContain('世界背景。');
    expect(fused).not.toContain('image###');
  });
});
