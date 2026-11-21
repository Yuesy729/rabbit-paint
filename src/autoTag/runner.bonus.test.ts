import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  context: null as any,
  queue: [] as string[],
  calls: [] as Array<{ source: string; messages: any[]; savedCount: number; warnings?: string[] }>,
  saved: [] as string[],
}));
vi.mock('@/st/context', async original => ({ ...await original<any>(), getContext: () => mocks.context }));
vi.mock('@/api/client', () => {
  const run = async (messages: any[], options: any) => {
    mocks.calls.push({ source: options.source, messages, savedCount: mocks.saved.length });
    const raw = mocks.queue.shift();
    if (!raw) throw new Error('没有排定的模拟响应');
    options.validate(raw);
    mocks.calls.at(-1)!.warnings = options.validationWarnings?.();
    return raw;
  };
  return { requestViaMainApi: run, requestCompletion: (_channel: any, messages: any[], options: any) => run(messages, options) };
});
vi.mock('@/autoTag/context', () => ({
  fetchWorldInfo: async () => '', fetchCharCard: () => '', fetchUserPersona: () => '',
  buildWorldInfoSystem: (s: string) => s, buildCharCardSystem: (s: string) => s, buildPersonaSystem: (s: string) => s,
}));
vi.mock('@/autoTag/bookMemory', () => ({ readBookMemory: () => null }));
vi.mock('@/floor/autoGenerate', () => ({
  markForAutoGenerate: vi.fn(), consumeAutoGenerate: vi.fn(), clearAutoGenerateForFloor: vi.fn(),
}));
vi.mock('@/state/charTags', () => ({
  BBI_CHAR_EXTRA_KEY: 'bbi_char_tags',
  CHAR_TAG_FIELDS: ['sex', 'hair', 'eyes', 'skin', 'body', 'extra', 'outfit', 'fandom'],
  charTagsBeforeFloor: () => [], lockedCharTagNames: () => new Set(),
  emptyCharFields: () => ({}), createCharTagNewOp: vi.fn(), createCharTagSetOp: vi.fn(),
  applyCharTagOps: (entries: any) => entries,
  makeCharTagFloorDelta: (ops: any[], swipeId: number) => ({ ops, swipeId }),
  readCharTagFloorDelta: () => null, recomputeCharTags: vi.fn(),
}));
vi.mock('@/st/messageEdit', () => ({
  applyMessageText: async (floor: number, build: any, chatId: string, _swipe: any, _message: any, extra: any) => {
    if (chatId !== mocks.context.getCurrentChatId()) return 'chat-changed';
    const next = build(mocks.context.chat[floor].mes);
    if (next === null) return 'build-failed';
    mocks.context.chat[floor].mes = next;
    if (extra) mocks.context.chat[floor].extra[extra.key] = extra.value;
    mocks.saved.push(next);
    return 'saved';
  },
}));

import { settings, activeNaiPlan, activeComfyPreset, builtinComfyPromptSet } from '@/state/settings';
import { requestFloorTags, requestFloorBonus, requestSlotTag } from '@/autoTag/runner';
import { parseImageTags, parseImageTagContent } from '@/st/imageTagRegex';
import { withSceneReview } from '@/autoTag/reviewFixture.testSupport';

const story = '第一段。\n第二段。\n第三段。';
const normal = JSON.stringify({ images: [1, 2, 3].map(p => ({ position: `P${p}`, tag: 'no humans, forest' })), changes: [] });
const bonus = JSON.stringify({ bonus: { tag: 'no humans, forest, watercolor', characters: [], size: 'portrait' } });

describe('整楼与彩蛋请求集成', () => {
  beforeEach(() => {
    mocks.calls.length = 0; mocks.saved.length = 0; mocks.queue.length = 0;
    vi.stubGlobal('toastr', { success: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() });
    mocks.context = {
      chat: [{ mes: story, name: '角色', is_user: false, is_system: false, extra: { keep: '原图片数据' } }],
      chatMetadata: {}, name1: 'User', name2: '角色', getCurrentChatId: () => 'bonus-test',
      eventSource: { on: vi.fn() }, eventTypes: {},
    };
    settings.autoTag.worldbookPreset = 'builtin';
    settings.enabled = true;
    settings.defaultBackend = 'nai'; activeNaiPlan().naturalLanguage = false;
    settings.assignments.tagGen = ''; settings.autoTag.minImages = 0; settings.autoTag.maxImages = 3;
    settings.autoTag.retryCount = 1; settings.autoTag.autoGenerate = false;
    settings.autoTag.bonus = { enabled: true, prompt: '只画森林的水彩彩蛋。' };
    settings.autoTag.prompts.naiV5Thinking = '原有自定义提示词原文';
    settings.excludes.excludedChars = [];
  });

  it('三张正文加一张末尾彩蛋,不占正文上限,原自定义提示词保留', async () => {
    mocks.queue.push(normal, bonus);
    await requestFloorTags(0);
    const tags = parseImageTags(mocks.context.chat[0].mes);
    expect(tags).toHaveLength(4);
    expect(tags.map(t => !!parseImageTagContent(t).bonus)).toEqual([false, false, false, true]);
    expect(mocks.context.chat[0].mes.endsWith(tags[3])).toBe(true);
    expect(mocks.calls).toHaveLength(2);
    expect(mocks.calls[1].source).toContain('末尾彩蛋');
    expect(mocks.calls[1].savedCount).toBe(1);
    expect(mocks.calls[0].messages.some(m => m.content.includes('只画森林的水彩彩蛋'))).toBe(false);
    expect(settings.autoTag.prompts.naiV5Thinking).toBe('原有自定义提示词原文');
    expect(mocks.context.chat[0].extra.keep).toBe('原图片数据');
  });

  it('启用喵喵后实际正文与彩蛋各读取对应原条目,彩蛋单槽重写仍读取原彩蛋说明', async () => {
    settings.autoTag.worldbookPreset = 'miaomiao';
    settings.autoTag.bonus!.prompt = '';
    mocks.queue.push(withSceneReview(normal), withSceneReview(bonus));
    await requestFloorTags(0);
    expect(mocks.calls).toHaveLength(2);
    const storyPrompt = mocks.calls[0].messages.map(m => m.content).join('\n');
    const bonusPrompt = mocks.calls[1].messages.map(m => m.content).join('\n');
    expect(storyPrompt).toContain('【喵喵绘图指导｜融合到现有插件字段】');
    expect(storyPrompt).not.toContain('独立彩蛋内容 → 当前彩蛋对象');
    expect(storyPrompt).toContain('原有自定义提示词原文');
    expect(storyPrompt).not.toContain('image###');
    expect(bonusPrompt).toContain('独立彩蛋内容 → 当前彩蛋对象');
    expect(bonusPrompt).toContain('Mochi / super deformed');
    expect(bonusPrompt).not.toContain('彩蛋固定画风与内容');
    const before = parseImageTags(mocks.context.chat[0].mes);
    mocks.queue.push(withSceneReview(JSON.stringify({ images: [{ position: 'P1', tag: 'no humans, forest, night' }] })));
    await requestSlotTag(0, 3);
    const after = parseImageTags(mocks.context.chat[0].mes);
    expect(mocks.calls).toHaveLength(3);
    expect(mocks.calls[2].messages.some(m => m.content.includes('独立彩蛋内容 → 当前彩蛋对象'))).toBe(true);
    expect(after.slice(0, 3)).toEqual(before.slice(0, 3));
    expect(parseImageTagContent(after[3]).bonus).toBe(true);
    expect(settings.autoTag.prompts.naiV5Thinking).toBe('原有自定义提示词原文');
  });

  it('关闭后只发正文请求,也不接受模型顺带返回的彩蛋', async () => {
    settings.autoTag.bonus!.enabled = false;
    mocks.queue.push(normal);
    await requestFloorTags(0);
    expect(mocks.calls).toHaveLength(1);
    expect(parseImageTags(mocks.context.chat[0].mes)).toHaveLength(3);
    const before = mocks.context.chat[0].mes;
    await requestFloorBonus(0);
    expect(mocks.calls).toHaveLength(1);
    expect(mocks.context.chat[0].mes).toBe(before);
  });

  it('遇到截图中的缺失数组错误,重试明确反馈错误并恢复完整数组计划', async () => {
    settings.autoTag.worldbookPreset = 'miaomiao';
    settings.autoTag.bonus!.enabled = false;
    mocks.queue.push('{"position":"P1","tag":"wrong root"}', withSceneReview(normal));
    await requestFloorTags(0);
    expect(mocks.calls).toHaveLength(2);
    expect(mocks.calls[0].messages.at(-1)?.content).not.toContain('上一次返回没有通过插件校验');
    expect(mocks.calls[1].messages.at(-1)?.content).toContain('AI 返回的 JSON 缺少 images 数组');
    expect(mocks.calls[1].messages.some(m => m.content === '原有自定义提示词原文')).toBe(true);
    expect(parseImageTags(mocks.context.chat[0].mes)).toHaveLength(3);
    expect(settings.autoTag.retryCount).toBe(1);
    expect(settings.autoTag.maxImages).toBe(3);
  });

  it('只校验彩蛋协议,原文允许的其他画风无需 Q版标签也不会白白重试', async () => {
    mocks.queue.push(normal, bonus);
    await requestFloorTags(0);
    expect(mocks.calls).toHaveLength(2);
    const tags = parseImageTags(mocks.context.chat[0].mes).map(parseImageTagContent);
    expect(tags).toHaveLength(4);
    expect(tags.slice(0, 3).every(tag => tag.tag === 'no humans, forest')).toBe(true);
    expect(tags[3].tag).toBe('no humans, forest, watercolor');
    expect(settings.autoTag.bonus!.prompt).toBe('只画森林的水彩彩蛋。');
    expect(settings.autoTag.maxImages).toBe(3);
  });

  it('自检引用不一致只记提示,保留实际tag且不重试或写入正文', async () => {
    settings.autoTag.worldbookPreset = 'miaomiao';
    settings.autoTag.bonus!.enabled = false;
    const good = withSceneReview(normal);
    const bad = good.replace('"1":[["tag","no humans"]]', '"1":[["tag","from above"]]');
    mocks.queue.push(bad, good);
    await requestFloorTags(0);
    expect(mocks.calls).toHaveLength(1);
    expect(mocks.calls[0].warnings?.[0]).toContain('最终 tag 中不存在');
    expect(parseImageTags(mocks.context.chat[0].mes).every(tag => parseImageTagContent(tag).tag === 'no humans, forest')).toBe(true);
    expect(parseImageTags(mocks.context.chat[0].mes)).toHaveLength(3);
    expect(mocks.context.chat[0].mes).not.toContain('image_check');
    expect(mocks.context.chat[0].mes).not.toContain('scene_plan');
  });

  it('彩蛋漏逐图核对只提示,不额外调用API且保留正文', async () => {
    settings.autoTag.worldbookPreset = 'miaomiao';
    mocks.queue.push(withSceneReview(normal), bonus, withSceneReview(bonus));
    await requestFloorTags(0);
    expect(mocks.calls).toHaveLength(2);
    expect(mocks.calls[1].savedCount).toBe(1);
    expect(mocks.calls[1].warnings?.[0]).toContain('scene_plan');
    expect(parseImageTags(mocks.context.chat[0].mes)).toHaveLength(4);
    expect(mocks.context.chat[0].extra.keep).toBe('原图片数据');
  });

  it('彩蛋失败只重试彩蛋并保留正文,星星入口可单独补齐且不会重复添加', async () => {
    mocks.queue.push(normal, '{"bonus":null}', '{"bonus":null}');
    await requestFloorTags(0);
    expect(mocks.calls).toHaveLength(3);
    expect(mocks.calls.filter(c => c.source.startsWith('自动 tag'))).toHaveLength(1);
    expect(parseImageTags(mocks.context.chat[0].mes)).toHaveLength(3);
    const before = mocks.context.chat[0].mes;
    const extraBefore = JSON.stringify(mocks.context.chat[0].extra);
    mocks.queue.push(bonus);
    await requestFloorBonus(0);
    expect(mocks.context.chat[0].mes.startsWith(before)).toBe(true);
    expect(parseImageTags(mocks.context.chat[0].mes)).toHaveLength(4);
    expect(JSON.stringify(mocks.context.chat[0].extra)).toBe(extraBefore);
    await requestFloorBonus(0);
    expect(mocks.calls).toHaveLength(4);
  });

  it('重写彩蛋单槽只请求一次,保留彩蛋标记与其他三张图', async () => {
    mocks.queue.push(normal, bonus);
    await requestFloorTags(0);
    const before = parseImageTags(mocks.context.chat[0].mes);
    mocks.calls.length = 0;
    settings.autoTag.bonus!.enabled = false;
    mocks.queue.push(JSON.stringify({ images: [{ position: 'P1', tag: 'no humans, forest, night' }] }));
    await requestSlotTag(0, 3);
    const after = parseImageTags(mocks.context.chat[0].mes);
    expect(after).toHaveLength(4);
    expect(after.slice(0, 3)).toEqual(before.slice(0, 3));
    expect(parseImageTagContent(after[3]).bonus).toBe(true);
    expect(mocks.calls).toHaveLength(1);
  });

  it('正文返回零图也能独立生成彩蛋', async () => {
    mocks.queue.push('{"images":[],"changes":[]}', bonus);
    await requestFloorTags(0);
    expect(mocks.calls).toHaveLength(2);
    const tags = parseImageTags(mocks.context.chat[0].mes);
    expect(tags).toHaveLength(1);
    expect(parseImageTagContent(tags[0]).bonus).toBe(true);
  });
});


// 新版漫画走上游原生分镜协议,与插画自检/彩蛋隔离。
describe('0.3.5 漫画与兔宝绘流程衔接', () => {
  beforeEach(() => {
    mocks.calls.length = 0; mocks.saved.length = 0; mocks.queue.length = 0;
    vi.stubGlobal('toastr', { success: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() });
    mocks.context = {
      chat: [{ mes: story, name: '角色', is_user: false, is_system: false, extra: { keep: '原图片数据' } }],
      chatMetadata: {}, name1: 'User', name2: '角色', getCurrentChatId: () => 'comic-sync-test',
      eventSource: { on: vi.fn() }, eventTypes: {},
    };
    settings.enabled = true; settings.defaultBackend = 'comfyui';
    activeComfyPreset().kind = 'comic';
    activeComfyPreset().promptSetId = builtinComfyPromptSet('comic').id;
    settings.assignments.tagGen = ''; settings.autoTag.worldbookPreset = 'miaomiao';
    settings.autoTag.minImages = 0; settings.autoTag.maxImages = 0; settings.autoTag.retryCount = 1;
    settings.autoTag.autoGenerate = false;
    settings.autoTag.bonus = { enabled: true, prompt: '' };
  });
  const page = { position: 'P2', size: 'landscape', summary: 'Forest page', items: [{ label: 'object', caption: 'A tree', bbox: [0, 0, 1000, 1000] }] };

  it('漫画使用pages,彩蛋单独一页并保留身份,不会混进images自检协议', async () => {
    mocks.queue.push(JSON.stringify({ pages: [page], changes: [] }), JSON.stringify({ bonus: page, changes: [] }));
    await requestFloorTags(0);
    const tags = parseImageTags(mocks.context.chat[0].mes).map(parseImageTagContent);
    expect(tags).toHaveLength(2);
    expect(tags.map(tag => tag.kind)).toEqual(['comic', 'comic']);
    expect(tags.map(tag => !!tag.bonus)).toEqual([false, true]);
    expect(tags[1].layout?.summary).toBe('Forest page');
    expect(mocks.calls).toHaveLength(2);
    expect(mocks.calls[0].warnings).toEqual([]);
    const storyPrompt = mocks.calls[0].messages.map(m => m.content).join('\n');
    expect(storyPrompt).toContain('pages');
    expect(storyPrompt).not.toContain('根级 images 必须是数组');
    expect(storyPrompt).not.toContain('<image_check');
    const bonusPrompt = mocks.calls[1].messages.map(m => m.content).join('\n');
    expect(bonusPrompt).toContain('独立末尾彩蛋任务');
    expect(bonusPrompt).toContain('Mochi / super deformed');
    expect(mocks.context.chat[0].extra.keep).toBe('原图片数据');
  });

  it('漫画失败重试继续要求分镜,不会切换成插画数组', async () => {
    settings.autoTag.bonus!.enabled = false;
    mocks.queue.push('{"pages":[]}', JSON.stringify({ pages: [page], changes: [] }));
    await requestFloorTags(0);
    expect(mocks.calls).toHaveLength(2);
    const feedback = mocks.calls[1].messages.at(-1)?.content;
    expect(feedback).toContain('pages/bonus 分镜协议');
    expect(feedback).not.toContain('根级 images 与 changes 都使用数组');
    expect(parseImageTags(mocks.context.chat[0].mes)).toHaveLength(1);
  });
});
