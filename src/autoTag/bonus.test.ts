import { describe, expect, it, vi } from 'vitest';
import { prepareTargetText } from '@/autoTag/clean';
import { parseBonusPlan, parseImagePlan, appendBonusImage, injectImageTags } from '@/autoTag/protocol';
import { requestBonusWithRetry } from '@/autoTag/bonusRequest';
import { bonusOutputContract, storyOutputPolicy } from '@/autoTag/bonusPolicy';
import { formatPromptText, parseImageTagContent, parseImageTags, stripImageTags, serializeImageTag } from '@/st/imageTagRegex';
import type { AutoTagSettings } from '@/state/settings';

const body = '正文第一段\r\n正文第二段\r\n正文第三段\r\n<status>已有状态栏</status>';
const segments = prepareTargetText(body, ['status']).segments;
const profile = { nl: false, naiCharPrompts: true };
const raw = JSON.stringify({ bonus: { position: 'P999', tag: 'no humans, forest, watercolor', characters: [], size: 'portrait' }, changes: [{ name: '不要落档', field: 'new' }] });

describe('独立彩蛋协议', () => {
  it('三张正文不会占用彩蛋名额,彩蛋由程序追加到真实文本末尾', () => {
    const ordinary = parseImagePlan(JSON.stringify({ images: segments.slice(0, 3).map(s => ({ position: s.id, tag: 'forest' })) }), segments, 0, 3);
    const bonus = parseBonusPlan(raw, segments, profile);
    expect(ordinary.images).toHaveLength(3);
    expect(bonus.images).toHaveLength(1);
    expect(bonus.changes).toEqual([]);
    expect(bonus.images[0].position).toBe(segments.at(-1)!.id);
    const withStory = injectImageTags(body, ordinary.images);
    const output = appendBonusImage(withStory, bonus.images[0]);
    const tags = parseImageTags(output);
    expect(tags).toHaveLength(4);
    expect(tags.filter(t => parseImageTagContent(t).bonus)).toHaveLength(1);
    expect(output.endsWith(tags[3])).toBe(true);
    expect(output.indexOf('<status>已有状态栏</status>')).toBeLessThan(output.indexOf(tags[3]));
    expect(stripImageTags(output)).toBe(body);
  });

  it('缺少独立 bonus、空 tag 或错误结构都不能被当成成功', () => {
    for (const value of [{ images: [{ tag: 'forest' }] }, { bonus: [] }, { bonus: {} }, { bonus: { tag: ' ' } }]) {
      expect(() => parseBonusPlan(JSON.stringify(value), segments, profile)).toThrow();
    }
    expect(() => parseBonusPlan(JSON.stringify({ bonus: { tag: '1girl', characters: [] } }), segments, profile)).toThrow('角色块');
    expect(() => parseBonusPlan(raw, segments, { ...profile, nl: true })).toThrow('自然语言');
  });

  it('关闭开关的普通解析不会消费模型多返回的 bonus', () => {
    const result = parseImagePlan(JSON.stringify({ images: [{ position: 'P1', tag: 'forest' }], bonus: { tag: 'bonus' } }), segments, 0, 3);
    expect(result.images).toHaveLength(1);
    expect(result.images[0].bonus).toBeUndefined();
  });

  it('彩蛋标记能跨序列化保存且不会进入实际画面提示词', () => {
    const image = parseBonusPlan(raw, segments, profile).images[0];
    const parsed = parseImageTagContent(serializeImageTag(image));
    expect(parsed.bonus).toBe(true);
    expect(parsed.tag).toBe('no humans, forest, watercolor');
    expect(formatPromptText(parsed)).not.toContain('<bonus>');
    expect(parseImageTagContent(serializeImageTag({ ...parsed, tag: 'forest, night' })).bonus).toBe(true);
  });
});

describe('彩蛋独立请求与重试', () => {
  it('第一次缺彩蛋时只重试这项请求', async () => {
    const request = vi.fn(async (attempt, validate, _previousError: string) => validate(attempt === 1 ? '{"images":[]}' : raw));
    const result = await requestBonusWithRetry(request, segments, profile, 1, new AbortController().signal, () => true);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1][2]).toContain('彩蛋缺失');
    expect(result?.images[0].bonus).toBe(true);
  });

  it('关闭开关时既不请求,也不消费在途返回', async () => {
    const request = vi.fn();
    expect(await requestBonusWithRetry(request, segments, profile, 1, new AbortController().signal, () => false)).toBeNull();
    expect(request).not.toHaveBeenCalled();
    let enabled = true;
    const inFlight = vi.fn(async (_attempt, validate) => { validate(raw); enabled = false; });
    expect(await requestBonusWithRetry(inFlight, segments, profile, 1, new AbortController().signal, () => enabled)).toBeNull();
  });

  it('达到重试次数后明确失败;取消后不重试', async () => {
    const request = vi.fn(async (_attempt, validate) => validate('{"bonus":null}'));
    await expect(requestBonusWithRetry(request, segments, profile, 1, new AbortController().signal, () => true)).rejects.toThrow('彩蛋缺失');
    expect(request).toHaveBeenCalledTimes(2);
    const controller = new AbortController(); controller.abort();
    const never = vi.fn();
    await expect(requestBonusWithRetry(never, segments, profile, 1, controller.signal, () => true)).rejects.toThrow('已取消');
    expect(never).not.toHaveBeenCalled();
  });

  it('正文/单槽/彩蛋三种任务分别约束;自定义彩蛋说明只进入彩蛋请求', () => {
    const options = { minImages: 0, maxImages: 3, bonus: { enabled: true, prompt: '专属彩蛋说明' } } as AutoTagSettings;
    expect(storyOutputPolicy(options, 'story')).toContain('0～3');
    expect(storyOutputPolicy(options, 'story')).not.toContain('专属彩蛋说明');
    expect(storyOutputPolicy(options, 'slot')).toContain('images 恰好一项');
    expect(bonusOutputContract(options, false, true)).toContain('专属彩蛋说明');
    expect(bonusOutputContract(options, false, true)).not.toContain('"nl"');
    expect(bonusOutputContract(options, true, true)).toContain('"nl"');
  });
});
