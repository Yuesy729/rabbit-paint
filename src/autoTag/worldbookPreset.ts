import source from '@/autoTag/presets/miaomiao-1.5-1.json?raw';
import type { AutoTagSettings } from '@/state/settings';
import type { TagTaskMode } from '@/autoTag/bonusPolicy';
import { MIAOMIAO_CHECK_IDS } from '@/autoTag/sceneReview';

interface Entry { comment: string; content: string }
const entries = Object.values((JSON.parse(source) as { entries: Record<string, Entry> }).entries);
const sourceContents = new Set(entries.map(item => item.content.trim().replace(/\r\n/g, '\n')));
export const MIAOMIAO_SOURCE_TEXT = source;
export const MIAOMIAO_SOURCE_NAME = '[喵喵]文生图 1.5-1.json';
export const MIAOMIAO_SOURCE_PREVIEW = entries
  .filter(entry => ['主体', '自检', 'bg[选一]', '彩蛋[选开]'].includes(entry.comment))
  .map(entry => `【${entry.comment}】\n${entry.content}`).join('\n\n');

/** 融合模式避免同一份旧任务又随已启用的世界书重复发送。 */
export function isMiaomiaoSourceContent(text: string): boolean {
  return sourceContents.has(text.trim().replace(/\r\n/g, '\n'));
}

export function stripMiaomiaoLegacyBlock(text: string): string {
  return text.replace(/<imageTag>[\s\S]*?<\/imageTag>/gi, block =>
    block.includes('了解组成') && block.includes('多人交互逻辑') ? '' : block).trim();
}

function entry(name: string): string {
  const value = entries.find(item => item.comment === name)?.content;
  if (!value) throw new Error(`喵喵来源缺少条目：${name}`);
  return value;
}

/** 从原条目取变量的文字值,不执行原宏或整篇输出任务。 */
function variableValue(text: string, name: string): string {
  const marker = `{{setvar::${name}::`;
  const start = text.indexOf(marker);
  if (start < 0) throw new Error(`喵喵来源缺少变量：${name}`);
  let cursor = start + marker.length, depth = 1;
  const contentStart = cursor;
  while (cursor < text.length) {
    if (text.slice(cursor, cursor + 2) === '{{') { depth++; cursor += 2; }
    else if (text.slice(cursor, cursor + 2) === '}}') {
      if (--depth === 0) return text.slice(contentStart, cursor);
      cursor += 2;
    } else cursor++;
  }
  throw new Error('喵喵来源变量未闭合');
}

function numberedSections(text: string): Map<number, string> {
  const matches = [...text.matchAll(/^(\d+)\.\s*([^\n]*)/gm)];
  return new Map(matches.map((match, index) => [Number(match[1]), text.slice(match.index!, matches[index + 1]?.index ?? text.length).trim()]));
}

const subject = entry('主体');
const composition = numberedSections(subject.slice(subject.indexOf('## 了解组成'), subject.indexOf('{{getvar::彩蛋要求}}')));
const checks = numberedSections(entry('自检'));
const stateNotes = subject.slice(subject.indexOf('注1:'), subject.indexOf('注3:'));
const sceneFocus = subject.match(/^5\.[^\n]*$/m)?.[0] ?? '';

/** 原画面要求按插件字段归位。旧任务、计数宏、输出例子均不参与请求。 */
function fieldRules(text: string, nativeCharacters: boolean): string {
  return text.split('\n')
    .filter(line => !line.includes('{{') && !line.includes('是否补充基础质量tag') && !line.includes('masterpiece等') && !/<\/?(?:imgthink|content)>|image###|^\s*(?:-\s*)?\((?:Name|Character[A-Z]):/i.test(line))
    .map(line => line
      .replace(/^\d+\.\s*/, '')
      .replace(/独立括号\s*\+\s*(?:完整描述\s*\+\s*)?权重/g, nativeCharacters ? '独立角色对象及后端允许的权重' : '独立人物分组及后端允许的权重')
      .replace(/角色括号外|角色模板括号外部|括号外部/g, nativeCharacters ? 'Base 场景字段' : '共同交互区域')
      .replace(/括号包裹/g, nativeCharacters ? 'characters[] 分组' : '独立人物分组')
      .replace('在content内的“关键画面时刻”插入tag，实现图文结合效果', '本图对应目标正文的合法P编号，tag由插件按位置写入')
      .replace('**著名ACGN角色：是否使用固定名字tag（避免自定义描述/使用a girl 或者a boy）**', '著名ACGN角色：身份tag是否与档案及后端规范一致（角色分组和固定特征仍按原插件流程）')
      .replace(/\(例:wide eyes:0\.7\)/g, '(权重数值保留,语法按当前后端规范)'))
    .join('\n').trim();
}

export function renderMiaomiao(_options: AutoTagSettings, mode: TagTaskMode, nativeCharacters = true): string {
  const bonus = mode === 'bonus' || mode === 'bonus-slot';
  const block = (title: string, text: string) => `【${title}】\n${fieldRules(text, nativeCharacters)}`;
  const part = (numbers: number[]) => numbers.map(number => composition.get(number) ?? '').join('\n\n');
  const review = MIAOMIAO_CHECK_IDS.map(number => `自检第${number}项\n${checks.get(number) ?? ''}`).join('\n\n');
  const bg = variableValue(entry('bg[选一]'), '性向绘画');
  return [
    '【喵喵绘图指导｜融合到现有插件字段】\n沿用原插件的角色建档、选段、张数、后端规范与最终 JSON 协议。以下是画面内容补充,在原生成流程的对应步骤使用。tag 规则只约束 tag 字段,nl 仍按原后端规范填写。',
    block('选定画面 → 本图构图与关系', part([1, 4, 5])),
    block('人物字段 → 各角色的 tag 与 nl', part([3, 7, 8, 9, 10, 11]) + '\n\n' + stateNotes),
    block('场景字段 → Base 的 tag 与 nl', part([12, 13, 14])),
    block('原文的场景细节要求 → 按角色与共同交互归属', sceneFocus + '\n' + part([15]) + '\n' + bg),
    block('落字段后核对 → tag 精确度、角色归属与画面一致性', review),
    '【结构归属】\n身份和固定特征继续使用原角色库及当前后端规范。质量词、画师词继续走原有配置,不在本图重复添加。数量、位置和输出容器由原插件协议负责。',
    ...(bonus ? [block('独立彩蛋内容 → 当前彩蛋对象', variableValue(entry('彩蛋[选开]'), '彩蛋要求')), '四格漫画仍属于一张图内的分镜,不增加图片对象；彩蛋演绎不修改正文或永久角色档案。'] : []),
  ].join('\n\n');
}

/** 最后只保留一个结构范例,用于锁定数组类型及后端人物字段。 */
export function miaomiaoFormatAdapter(options: AutoTagSettings, mode: TagTaskMode, nativeCharacters: boolean, nl: boolean, position = 'P1'): string {
  const single = mode === 'slot' || mode === 'bonus-slot';
  const image = {
    ...(mode !== 'bonus' ? { position } : {}), tag: 'cafe, warm light',
    ...(nl ? { nl: 'A cafe in warm light.' } : {}),
    ...(nativeCharacters ? { characters: [{ name: '示例角色', tag: 'black hair, sweater, smile', ...(nl ? { nl: 'The character wears a sweater and smiles.' } : {}) }] } : {}),
    size: 'portrait',
  };
  const example = mode === 'bonus' ? { images: [], changes: [], bonus: image } : { images: [image], changes: [], bonus: null };
  return `【最终输出协议｜沿用兔宝绘原框架】
最终输出一个 JSON 对象。根级 images 必须是数组,changes 也必须是数组；本图角色在当前后端支持时写入对应图片的 characters 数组。不要把单张图或单个人物对象当成根对象,不要使用字符串代替数组。
${mode === 'bonus' ? '本次仅生成额外的一张彩蛋：images 与 changes 均为空数组,bonus 是一个完整对象。' : `本次只填写正文 images：${single ? '恰好1项,仅替换指定槽位' : `数量范围${options.minImages}～${options.maxImages},并非固定1张`}；bonus 为 null,彩蛋由独立任务处理。`}
position 必须从本次目标正文的合法 P编号选择；示例的名字、内容、画幅和张数仅用于说明结构,实际以当前人物、画面和原设置为准。
${nativeCharacters ? '共同场景和交互进入 Base；每个人物分别进入 characters[] 的 name/tag' + (nl ? '/nl' : '') + ',不得合为共享外貌。' : '按当前后端规范将人物分组写入本图提示词。'}${nl ? 'Base 和人物的 nl 都使用英文,与 tag 对应。' : '本次未启用 nl。'}画幅与负面字段继续遵循原后端规范。
结构示例：
${JSON.stringify(example)}
输出前核对数组类型、必填字段和合法位置。最终生图 JSON 保持本段结构；前置选景和逐图核对按后面的流程约定输出,不输出其他解释或旧格式标记。`;
}


/** 漫画彩蛋只复用原题材指导,格式交给 MOSS 分镜协议。 */
export function miaomiaoBonusContent(): string {
  return fieldRules(variableValue(entry('彩蛋[选开]'), '彩蛋要求'), false);
}
