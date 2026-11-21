import { describe, expect, it } from 'vitest';
import { parseBonusPlan, parseImagePlan } from '@/autoTag/protocol';
import { validateSceneReview, inspectSceneReview, stripSceneReview } from '@/autoTag/sceneReview';
import { withSceneReview } from '@/autoTag/reviewFixture.testSupport';
import { injectImageTags } from '@/autoTag/protocol';

const segments = [{ id: 'P1', sourceLine: 0, text: '两人在咖啡店牵手。' }];
const image = {
  position: 'P1', tag: '2people, holding hands, side view, cafe', nl: 'Two people holding hands in a cafe.',
  characters: [
    { name: 'A', tag: 'boy, black hair, standing, gentle smile, looking at partner' },
    { name: 'B', tag: 'girl, brown hair, standing, shy smile, looking at partner' },
  ],
};
const raw = JSON.stringify({ images: [image], changes: [] });
const valid = () => withSceneReview(raw);
function editReview(text: string, edit: (items: any) => void) {
  return text.replace(/(<image_check index="1">)([\s\S]*?)(<\/image_check>)/, (_match, open, body, close) => {
    const value = JSON.parse(body); edit(value.items); return open + JSON.stringify(value) + close;
  });
}
const validate = (text: string) => validateSceneReview(text, parseImagePlan(text, segments, 1, 3), true);

describe('选景、逐图 tag 核对与最终数据隔离', () => {
  it('逐图核对映射到最终 tag,核对元数据不会改变 images 或写入正文', () => {
    const text = valid();
    validate(text);
    expect(parseImagePlan(text, segments, 1, 3)).toEqual(parseImagePlan(raw, segments, 1, 3));
    const output = injectImageTags(segments[0].text, parseImagePlan(text, segments, 1, 3).images);
    expect(output).not.toContain('scene_plan');
    expect(output).not.toContain('image_check');
  });

  it('重点、姿势和表情只写在核对或 nl,没有进入对应 tag 时必须失败', () => {
    const missingTag = editReview(valid(), items => { items['3'] = [['characters[1].tag', 'leaning closer']]; });
    expect(() => validate(missingTag)).toThrow('最终 tag 中不存在');
    expect(() => validate(editReview(valid(), items => { items['3'] = [['characters[1].nl', 'shy smile']]; }))).toThrow('无效正向 tag 字段');
    expect(() => validate(editReview(valid(), items => { items['4'] = [['tag', 'hand']]; }))).toThrow('最终 tag 中不存在');
  });

  it('不能只写检查通过、漏掉喵喵条目或跳过适用的人物互动', () => {
    expect(() => validate(editReview(valid(), items => { items['1'] = 'ok'; }))).toThrow('实际 tag 引用');
    expect(() => validate(editReview(valid(), items => { delete items['13']; }))).toThrow('第13项');
    expect(() => validate(editReview(valid(), items => { items['4'] = 'na:无互动'; }))).toThrow('不能跳过');
  });

  it('每个人物都要参与核对,不得只核对其中一个角色', () => {
    const text = editReview(valid(), items => {
      for (const key of ['3', '4', '9']) items[key] = [['characters[0].tag', 'gentle smile']];
    });
    expect(() => validate(text)).toThrow('有角色未参与');
  });

  it('选景编号、位置、人物与每张检查必须对应最终数组', () => {
    expect(() => validate(valid().replace('"position":"P1"', '"position":"P9"'))).toThrow('位置');
    expect(() => validate(valid().replace('index="1"', 'index="2"'))).toThrow('编号');
    expect(() => validate(valid().replace('"participants":["A","B"]', '"participants":["A"]'))).toThrow('角色数组');
    expect(() => validate(valid().replace(/<image_check[\s\S]*?<\/image_check>\n/, ''))).toThrow('每张图片');
  });

  it('支持零图与独立彩蛋,两者不混用正文位置规则', () => {
    const empty = withSceneReview('{"images":[],"changes":[]}');
    validateSceneReview(empty, parseImagePlan(empty, segments, 0, 3), true);
    const bonus = withSceneReview(JSON.stringify({ bonus: { ...image, position: undefined } }));
    const plan = parseBonusPlan(bonus, segments, { nl: false, naiCharPrompts: true });
    validateSceneReview(bonus, plan, true, true);
    expect(plan.images[0].bonus).toBe(true);
    expect(() => validateSceneReview(bonus, plan, true)).toThrow('位置');
  });

  it('检查标签破损、藏进字段或多个图片漏检查都不会被误当成生图数据', () => {
    expect(parseImagePlan('<scene_plan>{"scenes":[]}\n' + raw, segments, 1, 3)).toEqual(parseImagePlan(raw, segments, 1, 3));
    expect(() => parseImagePlan(JSON.stringify({ images: [{ ...image, tag: '<image_check>text</image_check>' }] }), segments, 1, 3)).toThrow();
    expect(() => validateSceneReview(valid(), parseImagePlan(raw, segments, 1, 3), true)).not.toThrow();
    const two = withSceneReview(JSON.stringify({ images: [image, image], changes: [] }));
    const partial = two.replace(/<image_check index="2">[\s\S]*?<\/image_check>\n/, '');
    expect(() => validateSceneReview(partial, parseImagePlan(partial, segments, 1, 3), true)).toThrow('每张图片');
  });

  it('单串后端也执行落 tag 核对,元数据中的 JSON 示例不干扰最终根对象', () => {
    const flat = withSceneReview(JSON.stringify({ images: [{ position: 'P1', tag: 'no humans, cafe, warm light' }] }));
    validateSceneReview(flat, parseImagePlan(flat, segments, 1, 3), false);
    const withExample = flat.replace('取景与人物互动', '示例 {"images":[]}').replace('示例 {"images":[]}', '示例 {\\"images\\":[]}');
    expect(parseImagePlan(withExample, segments, 1, 3).images[0].tag).toBe('no humans, cafe, warm light');
  });
});


describe('辅助检查容错,核心图片协议保持严格', () => {
  it.each([
    ['同一行标签', () => valid().replace(/\n/g, ' ')],
    ['大小写和空格', () => valid().replace(/scene_plan/g, 'SCENE_PLAN').replace(/image_check/g, 'IMAGE_CHECK').replace(/index="1"/g, 'index = "1"')],
    ['辅助正文损坏', () => '<scene_plan>broken</scene_plan><image_check index="1">bad</image_check>' + raw],
    ['辅助漏闭合', () => '<scene_plan>{"scenes":[]}\n' + raw],
    ['辅助JSON不闭合', () => '<scene_plan>{"scenes":[\n' + raw],
    ['辅助JSON在最终对象之后', () => raw + '\n<image_check>{"items":{}}'],
    ['最终对象后的辅助JSON损坏', () => raw + '\n<image_check>{"items":{'],
    ['辅助JSON与标签全部缺失', () => raw],
  ])('%s不影响有效图片', (_name, build) => {
    const text = build();
    const plan = parseImagePlan(text, segments, 1, 3);
    expect(plan).toEqual(parseImagePlan(raw, segments, 1, 3));
    expect(() => inspectSceneReview(text, plan, true)).not.toThrow();
  });

  it('空格、下划线及常见权重表达的等价引用不误报,原tag不改动', () => {
    const weighted = JSON.stringify({ images: [{ ...image, tag: '2people, {holding_hands}, (side view:1.2), 1.3::cafe::' }] });
    const text = editReview(withSceneReview(weighted), items => { items['1'] = [['tag', 'HOLDING HANDS, side-view, cafe']]; });
    const plan = parseImagePlan(text, segments, 1, 3);
    expect(inspectSceneReview(text, plan, true)).toEqual([]);
    expect(plan.images[0].tag).toContain('(side view:1.2)');
  });

  it('真实缺失动作保留为提示,不会自动塞入生图tag', () => {
    const text = editReview(valid(), items => { items['3'] = [['characters[1].tag', 'leaning closer']]; });
    const plan = parseImagePlan(text, segments, 1, 3);
    expect(inspectSceneReview(text, plan, true)[0]).toContain('leaning closer');
    expect(plan.images[0].characters[1].tag).not.toContain('leaning closer');
  });

  it('最终JSON、数组、位置及tag的错误仍拦截', () => {
    for (const text of ['{"images":[', '{"tag":"cafe"}', '{"images":{}}',
      '{"images":[{"position":"P99","tag":"cafe"}]}', '{"images":[{"position":"P1","tag":""}]}']) {
      expect(() => parseImagePlan(text, segments, 1, 3)).toThrow();
    }
  });
});
