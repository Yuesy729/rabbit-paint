import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { MIAOMIAO_SOURCE_TEXT, renderMiaomiao, miaomiaoFormatAdapter } from '@/autoTag/worldbookPreset';
import { buildAutoTagMessages, expandNlSections } from '@/autoTag/prompt';
import { parseImagePlan, parseBonusPlan } from '@/autoTag/protocol';
import { settings, DEFAULT_NAI_V5_THINKING, type AutoTagSettings } from '@/state/settings';
import type { STContext } from '@/st/context';

vi.mock('@/autoTag/context', () => ({
  fetchWorldInfo: async () => '', fetchCharCard: () => '', fetchUserPersona: () => '',
  buildWorldInfoSystem: (s: string) => s, buildCharCardSystem: (s: string) => s, buildPersonaSystem: (s: string) => s,
}));
const options = (): AutoTagSettings => ({
  ...settings.autoTag, worldbookPreset: 'miaomiao', minImages: 0, maxImages: 3,
  bonus: { enabled: true, prompt: '' },
  prompts: { ...settings.autoTag.prompts, jailbreak: '原置顶提示', naiV5Thinking: '用户原有思维链', naiV5Spec: '用户原有后端规范' },
});
const context = () => ({ chat: [{ name: 'Char', is_user: false, mes: '角色在咖啡店。' }], name1: 'User', name2: 'Char' }) as STContext;

describe('原框架内融合喵喵指导', () => {
  it('参考文件仍按原字节保留', () => {
    expect(createHash('sha256').update(MIAOMIAO_SOURCE_TEXT).digest('hex')).toBe('8fa2b4b9b4153603835a55eefe0963f4630796e1b0bcb3456d36eb39fbe20581');
  });

  it('只按插件字段融合画面指导,没有旧任务容器、宏、身份和张数指令', () => {
    const text = renderMiaomiao(options(), 'story');
    expect(text).toContain('人物字段 → 各角色的 tag 与 nl');
    expect(text).toContain('场景字段 → Base 的 tag 与 nl');
    expect(text).toContain('人物表情');
    expect(text).toContain('环境元素');
    expect(text).toContain('多人交互逻辑');
    expect(text).toContain('人物之间的位置关系、距离、前后景层次');
    for (const item of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13]) expect(text).toContain(`自检第${item}项`);
    expect(text).toContain('只使用可见的服装部位');
    expect(text).toContain('本次NSFW为[bg]');
    expect(text).not.toMatch(/image###|<\/?(?:imgthink|content)>|\{\{|ELLA|Human|0\(\+1\)|必须构思/);
    expect(text).not.toContain('本次NSFW为[bl]');
  });

  it('彩蛋指导只进入彩蛋及其单槽任务,数量始终交给原协议', () => {
    for (const mode of ['story', 'slot'] as const) expect(renderMiaomiao(options(), mode)).not.toContain('独立彩蛋内容 → 当前彩蛋对象');
    for (const mode of ['bonus', 'bonus-slot'] as const) {
      const text = renderMiaomiao(options(), mode);
      expect(text).toContain('独立彩蛋内容 → 当前彩蛋对象');
      expect(text).toContain('Mochi / super deformed');
      expect(text).toContain('4koma / comic strip');
      expect(text).not.toMatch(/image###|\{\{|0\(\+1\)/);
    }
  });

  it('所有后端开关下的最终示例都能经过真实数组解析和图片序列化前校验', () => {
    const segments = [{ id: 'P7', sourceLine: 6, text: '角色在咖啡店。' }];
    for (const native of [true, false]) for (const nl of [true, false]) for (const mode of ['story', 'slot', 'bonus', 'bonus-slot'] as const) {
      const text = miaomiaoFormatAdapter(options(), mode, native, nl, 'P7');
      const raw = text.split('结构示例：\n')[1].split('\n')[0];
      const value = JSON.parse(raw);
      expect(Array.isArray(value.images)).toBe(true);
      expect(Array.isArray(value.changes)).toBe(true);
      const plan = mode === 'bonus' ? parseBonusPlan(raw, segments, { nl, naiCharPrompts: native }) : parseImagePlan(raw, segments, 1, 3);
      expect(plan.images).toHaveLength(1);
      expect(plan.images[0].position).toBe('P7');
      expect(plan.images[0].characters).toHaveLength(native ? 1 : 0);
    }
  });

  it('融合时保留原自定义生成指导和后端规范,最后明确 images 数组,原字段不变', async () => {
    const config = options(), snapshot = JSON.stringify(config), beforeBackend = settings.defaultBackend;
    settings.defaultBackend = 'nai';
    try {
      const messages = await buildAutoTagMessages(context(), 0, config, null, undefined, '', '', { nl: false, naiCharPrompts: true, lockedSize: null, comic: false }, 'story');
      const thinkingIndex = messages.findIndex(m => m.content === '用户原有思维链');
      const guideIndex = messages.findIndex(m => m.content.includes('【喵喵绘图指导｜融合到现有插件字段】'));
      expect(thinkingIndex).toBeGreaterThan(-1);
      expect(guideIndex).toBeGreaterThan(thinkingIndex);
      expect(messages.some(m => m.content === '用户原有后端规范')).toBe(true);
      expect(messages.at(-2)?.content).toContain('根级 images 必须是数组');
      expect(messages.at(-2)?.content).toContain('数量范围0～3');
      expect(messages.at(-2)?.content).toContain('scene_plan');
      expect(messages.at(-2)?.content).toContain('image_check');
      expect(messages.at(-2)?.content).toContain('只写在检查或nl里而没有落入tag');
      expect(messages.map(m => m.content).join('\n')).not.toMatch(/image###|<imgthink>|必须构思/);
      expect(JSON.stringify(config)).toBe(snapshot);
      config.worldbookPreset = 'builtin';
      const old = await buildAutoTagMessages(context(), 0, config, null, undefined, '', '', { nl: false, naiCharPrompts: true, lockedSize: null, comic: false }, 'story');
      expect(old.some(m => m.content === '用户原有思维链')).toBe(true);
      expect(old.some(m => m.content.includes('【喵喵绘图指导｜融合到现有插件字段】'))).toBe(false);
    } finally { settings.defaultBackend = beforeBackend; }
  });

  it('原自定义内容为空时仍保留内置 NAI 生成指导,不再因融合开关而跳过', async () => {
    const config = options(), beforeBackend = settings.defaultBackend;
    config.prompts.naiV5Thinking = ''; settings.defaultBackend = 'nai';
    try {
      const messages = await buildAutoTagMessages(context(), 0, config, null, undefined, '', '', { nl: false, naiCharPrompts: true, lockedSize: null, comic: false }, 'story');
      expect(messages.some(m => m.content === expandNlSections(DEFAULT_NAI_V5_THINKING, false))).toBe(true);
    } finally { settings.defaultBackend = beforeBackend; }
  });
});
