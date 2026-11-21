import type { ImageInsertion, ImagePlan } from '@/autoTag/protocol';
import type { TagTaskMode } from '@/autoTag/bonusPolicy';

/** 与参考文件的自检编号一致,原文件没有第12项。 */
export const MIAOMIAO_CHECK_IDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13] as const;
const VISUAL_ITEMS = new Set([1, 3, 4, 9, 11]);
const BLOCK_PATTERN = /<(scene_plan|image_check)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi;

/** 忽略 JSON 字符串内的标签,绝不清洗实际图片字段。 */
function insideString(raw: string, end: number): boolean {
  let quoted = false, escaped = false, depth = 0;
  for (let i = 0; i < end; i++) {
    const char = raw[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '{' || char === '[') depth++;
    else if (char === '}' || char === ']') depth = Math.max(0, depth - 1);
    else if (char === '"' && depth > 0) quoted = true;
  }
  return quoted;
}

function reviewBlocks(raw: string) {
  return [...raw.matchAll(new RegExp(BLOCK_PATTERN.source, BLOCK_PATTERN.flags))].filter(match => !insideString(raw, match.index!)).map(match => ({
    kind: match[1].toLowerCase(), attributes: match[2], body: match[3],
    start: match.index!, end: match.index! + match[0].length,
  }));
}

/** 只剥独立元数据块,不会修改 JSON 字符串里的文字。 */
export function stripSceneReview(raw: string): string {
  let clean = raw;
  for (const block of reviewBlocks(raw).reverse()) {
    clean = clean.slice(0, block.start) + '\n' + clean.slice(block.end);
  }
  // 残缺外层标签不影响最终 JSON；其正文由根对象解析器处理。
  return clean.replace(/<\/?(?:scene_plan|image_check)\b[^>]*>/gi,
    (tag, offset: number) => insideString(clean, offset) ? tag : '\n');
}

function object(text: string, label: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(text.trim()); } catch { throw new Error(`${label}内容不是有效 JSON`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}必须是对象`);
  return value as Record<string, unknown>;
}

const normalized = (text: string) => text.trim().toLowerCase()
  .replace(/(?:^|\s)[+-]?\d+(?:\.\d+)?::/g, ' ').replace(/::/g, '')
  .replace(/:\s*[+-]?\d+(?:\.\d+)?\s*\)/g, ')')
  .replace(/[{}\[\]()]/g, '').replace(/[_-]/g, ' ').replace(/\s+/g, ' ').trim();

/** 辅助核对只产生诊断,有效生图计划始终交给原协议处理。 */
export function inspectSceneReview(raw: string, plan: ImagePlan, nativeCharacters: boolean, bonus = false): string[] {
  try { validateSceneReview(raw, plan, nativeCharacters, bonus); return []; }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [message.length > 350 ? message.slice(0, 350) + '…（详见返回原文）' : message];
  }
}
function positiveTag(image: ImageInsertion, field: string): string | undefined {
  if (field === 'tag') return image.tag;
  const match = /^characters\[(\d+)\]\.tag$/.exec(field);
  return match ? image.characters[Number(match[1])]?.tag : undefined;
}

/** 只验证公开的选景结果和 tag 映射,不接收逐步推理过程。不会把元数据添加到计划对象。 */
export function validateSceneReview(raw: string, plan: ImagePlan, nativeCharacters: boolean, bonus = false): void {
  const blocks = reviewBlocks(raw);
  const sceneBlocks = blocks.filter(block => block.kind === 'scene_plan');
  if (sceneBlocks.length !== 1 || blocks[0]?.kind !== 'scene_plan') throw new Error('必须先返回一个独立 scene_plan 选景清单');
  const sceneBlock = sceneBlocks[0];
  const leading = raw.slice(0, sceneBlock.start).replace(/<(think(?:ing)?)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '').trim();
  if (leading) throw new Error('选景清单前包含多余输出');
  const scenes = object(sceneBlock.body, 'scene_plan').scenes;
  if (!Array.isArray(scenes) || scenes.length !== plan.images.length) throw new Error('选景清单与最终图片数量不一致');
  const reviews = blocks.filter(block => block.kind === 'image_check');
  if (reviews.length !== plan.images.length) throw new Error('每张图片必须有一个独立 image_check');
  for (let index = 1; index < blocks.length; index++) {
    if (raw.slice(blocks[index - 1].end, blocks[index].start).trim()) throw new Error('选景与逐图检查之间不能夹入其他输出');
  }
  if (!raw.slice(blocks.at(-1)!.end).trim()) throw new Error('逐图检查后缺少最终 JSON');

  for (let index = 0; index < plan.images.length; index++) {
    const image = plan.images[index];
    const scene = scenes[index] as Record<string, unknown> | null;
    if (!scene || typeof scene !== 'object' || Array.isArray(scene) || scene.index !== index + 1) throw new Error('选景编号必须与最终图片顺序一一对应');
    if (typeof scene.focus !== 'string' || !scene.focus.trim()) throw new Error(`第${index + 1}张选景缺少画面重点`);
    if (scene.position !== (bonus ? 'END' : image.position)) throw new Error(`第${index + 1}张选景位置与最终图片不一致`);
    if (!Array.isArray(scene.participants) || scene.participants.some(name => typeof name !== 'string' || !name.trim()) || new Set(scene.participants).size !== scene.participants.length) throw new Error(`第${index + 1}张选景参与者必须是无重复的姓名数组`);
    const people = scene.participants as string[];
    if (nativeCharacters && (people.length !== image.characters.length || image.characters.some(character => !people.includes(character.name)))) throw new Error(`第${index + 1}张选景参与者与角色数组不一致`);
    const review = reviews[index];
    const id = /\bindex\s*=\s*["']?(\d+)["']?/i.exec(review.attributes);
    if (!id || Number(id[1]) !== index + 1) throw new Error('逐图自检编号必须与图片顺序一致');
    const items = object(review.body, `image_check ${index + 1}`).items;
    if (!items || typeof items !== 'object' || Array.isArray(items)) throw new Error(`第${index + 1}张缺少自检 items 对象`);
    const checks = items as Record<string, unknown>;
    if (Object.keys(checks).some(key => !MIAOMIAO_CHECK_IDS.some(id => String(id) === key))) throw new Error('自检包含未知条目编号');
    const referenced = new Set<string>();
    for (const item of MIAOMIAO_CHECK_IDS) {
      const value = checks[String(item)];
      if (typeof value === 'string' && value.startsWith('na:') && value.slice(3).trim().length >= 2) {
        if (item === 1 || item === 9 || (item === 3 && people.length > 0) || (item === 4 && people.length > 1)) throw new Error(`第${index + 1}张自检第${item}项不能跳过`);
        continue;
      }
      if (value === 'ok' && !VISUAL_ITEMS.has(item)) continue;
      if (!Array.isArray(value) || !value.length) throw new Error(`第${index + 1}张自检第${item}项必须填写实际 tag 引用,不能只写检查通过`);
      for (const pair of value) {
        if (!Array.isArray(pair) || pair.length !== 2 || pair.some(part => typeof part !== 'string' || !part.trim())) throw new Error('自检引用必须是 [字段路径,完整tag片段]');
        const [field, text] = pair as [string, string];
        const tag = positiveTag(image, field);
        if (tag === undefined) throw new Error(`自检引用了无效正向 tag 字段：${field}`);
        const actual = tag.split(',').map(normalized).filter(Boolean);
        const tokens = text.split(',').map(normalized).filter(Boolean);
        const missing = tokens.filter(token => !actual.includes(token));
        if (!tokens.length || missing.length) throw new Error(`第${index + 1}张自检写到了最终 tag 中不存在的内容：${missing.join(', ') || text}`);
        referenced.add(field);
      }
    }
    if (nativeCharacters && image.characters.some((_character, characterIndex) => !referenced.has(`characters[${characterIndex}].tag`))) throw new Error(`第${index + 1}张有角色未参与逐图 tag 核对`);
  }
}

export function sceneReviewOutputPrompt(mode: TagTaskMode, nativeCharacters: boolean): string {
  return `【选景与逐图落 tag｜本次外层输出约定】
先读取上面的喵喵主体绘图要求、完整自检条目和原后端规范,再通读目标正文。输出的是简短选景结论与可核对的字段映射,不输出逐步推理或额外 thinking 块。
1. 先给 scene_plan：按原张数和合法P编号选取不同单一瞬间。每个场景只列 index(从1连续编号)、position、focus(具体可见的画面重点)、participants(入镜角色原名数组)。不要只记事件名称,要抓住人物反应与关系变化。${mode === 'bonus' ? '本次只选一张额外彩蛋,position 固定 END。' : mode === 'slot' || mode === 'bonus-slot' ? '本次仅重写指定槽位,保持其原画面核心,不另选其他剧情。' : '正文规划不占用额外彩蛋名额；允许零图时 scenes 可以为空。'}
2. 逐图使用喵喵主体要求与自检,边核对边定稿本图tag。明确谁对谁做什么、双方姿势/手部动作、各自表情视线、接触与空间位置、镜头重点；只采用正文或设定有依据的可见细节。人物、共同交互和环境分别落进对应字段。发现内容只写在检查或nl里而没有落入tag,先补进tag再提交。
3. 每张图给一个 image_check,与最终图片编号一致。items 必须覆盖原自检编号 ${MIAOMIAO_CHECK_IDS.join('、')}。条目1、3、4、9以及适用的11必须用 [["字段路径","逐字复制的完整tag片段"]] 表示核对结果；多个片段用英文逗号分隔,每个片段都必须真的存在于该字段。其余格式/权重/身份/风格/完整性项目核对后可简写为 "ok"；不适用时用 "na:具体原因",有人物时不能跳过3,多人时不能跳过4,1和9始终要有tag引用。
${nativeCharacters ? '字段路径只允许 tag 或 characters[0].tag、characters[1].tag 等。每个入镜角色都要有自己的tag引用,participants必须与该图characters[].name一致。' : '当前后端使用单串提示词时,引用字段为 tag；人物动作与反应仍需在其中分清归属。'}检查只标最终定稿字段映射,不要提交中间稿。不要用一个 kissing 或 hugging 代替正文已有的双方动作与反应细节。
外层格式如下,各标签单独成块并换行；示例只说明字段类型,实际检查不得漏项,适用性由当前画面决定,不可照抄示例的na：
<scene_plan>{"scenes":[{"index":1,"position":"${mode === 'bonus' ? 'END' : '合法P编号'}","focus":"本图画面重点","participants":[]}]}</scene_plan>
<image_check index="1">{"items":{"1":[["tag","原tag完整片段"]],"2":"ok","3":"na:本图无人物","4":"na:本图无多人互动","5":"ok","6":"ok","7":"ok","8":"ok","9":[["tag","原tag完整片段"]],"10":"ok","11":"na:本图不适用","13":"ok"}}</image_check>
4. 最后一次性汇总全部定稿图片为前文规定的最终 JSON,images、characters、changes 的原数组结构不变。正文/单槽与独立bonus任务各用自己的原协议。零图时只给空 scenes 和最终JSON,不生成image_check。
程序对辅助检查采用宽容解析：格式或引用差异只记自检提示，不自动补写或改动最终tag；最终生图字段仍需有效。请继续认真完成上述核对。\nscene_plan和image_check仅供本次核对与请求记录,不属于生图数据；严禁写进tag、nl、negative、角色档案或正文。原先关于仅输出thinking和JSON、或仅输出JSON的外层限制以本段为准,字段内容规范仍全部遵守。`;
}
