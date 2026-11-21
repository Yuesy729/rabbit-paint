import { validateComicLayout, type ComicLayout } from '@/backends/mossLayout';
import { normalizeOrientation, type Orientation } from '@/backends/size';
import type { TargetSegment } from '@/autoTag/clean';
import { FORBIDDEN_SUBTAG, serializeImageTag } from '@/st/imageTagRegex';
import { stripSceneReview } from '@/autoTag/sceneReview';
import {
  CHAR_TAG_FIELDS,
  type CharTagField,
  type CharTagHistoryField,
} from '@/state/charTags';

export interface ImageCharacterPrompt {
  name: string;
  tag: string;
  nl: string;
}

export interface ImageInsertion {
  bonus?: boolean;
  /** 模型选择的目标正文位置 ID。 */
  position: string;
  /** 位置 ID 对应的原始物理行(0-based，仅插件内部使用)。 */
  sourceLine: number;
  /** danbooru 短 tag 部分(必填)。 */
  tag: string;
  /** 自然语言部分(可空;ComfyUI「生成自然语言」开启时由模型一并输出)。 */
  nl: string;
  /** 本画面动态负面 tag(可空;仅在 ComfyUI 工作流使用 %negative_prompt% 时要求模型输出)。 */
  negative: string;
  characters: ImageCharacterPrompt[];
  /** 画幅方向:模型只判横/竖,具体像素由用户在后端面板配置。漏给/乱给一律降级竖屏。 */
  size: Orientation;
  /** tag 类型(插件按当前方案定,不是 AI 选的);缺省插画,序列化时也不写。 */
  kind?: 'comic';
  /** 漫画一页的分镜(kind 为 comic 时);tag/nl/negative/characters 此时恒空。 */
  layout?: ComicLayout;
}

export interface ImagePlan {
  images: ImageInsertion[];
  /** AI 报告的角色库变更(建档/字段更新);调用方负责落库。 */
  changes: CharChange[];
}

/** AI 输出的单条角色变更(宽松形状;解析后字段全部合法才保留)。 */
export interface CharChange {
  name: string;
  /** 'new' = 建档;其余为字段名/整串/自然语言。 */
  field: CharTagHistoryField;
  value: string;
  /** 自然语言外貌句(new 建档时可附带)。 */
  nl?: string;
  reason: string;
  /**
   * 永久变化开始生效的位置。建档(new)不受此约束——角色的固定外貌是本楼全程
   * 成立的事实,不是「从某处开始」的变化,这里只作记录与排序用。
   */
  position: string;
  /** position 对应的原始物理行(0-based,仅插件内部使用)。 */
  sourceLine: number;
}

const HISTORY_FIELDS: ReadonlySet<string> = new Set([
  'fandom',
  'sex',
  'hair',
  'eyes',
  'skin',
  'body',
  'extra',
  'outfit',
  'new',
  'raw',
  'nl',
]);

interface SourceLine {
  text: string;
  eol: string;
}

function sourceLines(source: string): SourceLine[] {
  const lines: SourceLine[] = [];
  const newline = /\r\n|\n|\r/g;
  let start = 0;
  for (let match = newline.exec(source); match; match = newline.exec(source)) {
    lines.push({ text: source.slice(start, match.index), eol: match[0] });
    start = match.index + match[0].length;
  }
  lines.push({ text: source.slice(start), eol: '' });
  return lines;
}

function jsonObjects(raw: string): string[] {
  const cleaned = stripSceneReview(raw).replace(/<(think(?:ing)?|imgthink)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '').trim()
    .replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1').trim();
  const candidates: string[] = [cleaned];

  for (let start = 0; start < cleaned.length; start += 1) {
    if (cleaned[start] !== '{') continue;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < cleaned.length; index += 1) {
      const char = cleaned[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === '{') depth += 1;
      else if (char === '}' && --depth === 0) {
        candidates.push(cleaned.slice(start, index + 1));
        // 不再把一个根对象里面的角色/示例子对象当作另一个响应。
        start = index;
        break;
      }
    }
    if (depth !== 0) {
      // 只跳过可识别的损坏辅助对象,绝不把截断的 images 计划当成成功。
      const auxiliary = /^\{\s*"(?:scenes|items)"\s*:/.test(cleaned.slice(start));
      const nextPlan = /(?:\r?\n)[ \t]*(\{\s*"(?:images|pages|bonus|changes)"\s*:)/.exec(cleaned.slice(start + 1));
      if (auxiliary && nextPlan) {
        start = start + 1 + nextPlan.index + nextPlan[0].indexOf('{') - 1;
        continue;
      }
      if (auxiliary && candidates.slice(1).some(candidate => {
        try {
          const value = JSON.parse(candidate);
          return value && ('images' in value || 'pages' in value || 'bonus' in value);
        } catch { return false; }
      })) break;
      throw new Error('AI 返回的 JSON 未完整结束,请重新返回完整对象');
    }
  }
  return candidates;
}

function parseObject(raw: string): Record<string, unknown> {
  const candidates = jsonObjects(raw);
  let direct: unknown, directParsed = false;
  try { direct = JSON.parse(candidates[0]); directParsed = true; } catch { /* 含说明时再找根对象。 */ }
  if (directParsed) {
    if (direct && typeof direct === 'object' && !Array.isArray(direct)) return direct as Record<string, unknown>;
    throw new Error('AI 返回的 JSON 根级必须是对象,不是数组或单个值');
  }
  let result: Record<string, unknown> | undefined;
  for (const candidate of candidates) {
    try {
      const value: unknown = JSON.parse(candidate);
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        // 漏闭合外层标签遗留的辅助对象不能覆盖已找到的最终生图计划。
        const keys = Object.keys(value);
        if (keys.length && keys.every(key => key === 'scenes' || key === 'items')) continue;
        // 说明/示例在前,最终完整根对象在后；保留最终对象,再严格验证字段。
        result = value as Record<string, unknown>;
      }
    } catch {
      // 尝试下一个候选 JSON 块。
    }
  }
  if (result) return result;
  throw new Error('AI 没有返回可解析的 JSON 对象');
}

/** tag / nl / negative 内容里不允许出现的子标签字面量（口径见 st/imageTagRegex.ts）。 */

function sanitizeContent(value: unknown, field: string, index: number): string {
  const text = typeof value === 'string' ? value.trim().replace(/[\r\n]+/g, ' ') : '';
  if (text && FORBIDDEN_SUBTAG.test(text)) {
    throw new Error(`images[${index}].${field} 不得包含 bbi_image/tag/nl/negative/size 标签`);
  }
  return text;
}

function sanitizeCharacters(value: unknown, imageIndex: number): ImageCharacterPrompt[] {
  if (!Array.isArray(value)) return [];
  const characters: ImageCharacterPrompt[] = [];
  for (let index = 0; index < value.length && characters.length < 32; index += 1) {
    const raw = value[index];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    try {
      const name = sanitizeContent(item.name, `characters[${index}].name`, imageIndex);
      const tag = sanitizeContent(item.tag ?? item.prompt, `characters[${index}].tag`, imageIndex);
      const nl = sanitizeContent(item.nl, `characters[${index}].nl`, imageIndex);
      if (name && tag) characters.push({ name, tag, nl });
    } catch {
      // A malformed character prompt must not discard an otherwise valid image plan.
    }
  }
  return characters;
}

function sanitizePosition(value: unknown, index: number): string {
  const position = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!position) throw new Error(`images[${index}].position 不能为空`);
  if (!/^P\d+$/.test(position)) throw new Error(`images[${index}].position 必须是目标正文中的 P编号`);
  return position;
}

/**
 * 解析并严格校验模型给出的“目标位置 ID + 提示词”列表。tag 必填;nl/negative 选填。
 * size 一律容忍:归一不出就当竖屏——为它抛错会白白吃掉 runner 的重试次数。
 * 图片超过上限时本地硬截断;少于用户明确设置的下限则抛错,交给 runner 重试。
 * changes 全程宽容:单条坏就丢弃,绝不连累 images——角色档案漏一条只是这个角色本轮
 * 没锚定,为它作废整次输出会连图一起没有,那是更坏的结果。
 */
export function parseImagePlan(
  raw: string,
  segments: TargetSegment[],
  minImages: number,
  maxImages: number,
): ImagePlan {
  const parsed = parseObject(raw);
  if (!Array.isArray(parsed.images)) throw new Error('AI 返回的 JSON 缺少 images 数组');
  const normalizedMax = Math.max(1, Math.floor(Number(maxImages)) || 1);
  const normalizedMin = Math.min(
    normalizedMax,
    Math.max(0, Math.floor(Number(minImages)) || 0),
  );
  const positions = new Map(segments.map(segment => [segment.id, segment.sourceLine]));

  const images: ImageInsertion[] = [];
  for (let index = 0; index < parsed.images.length; index += 1) {
    const item = parsed.images[index];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`images[${index}] 必须是对象`);
    }
    const entry = item as Record<string, unknown>;
    const position = sanitizePosition(entry.position ?? entry.id, index);
    const sourceLine = positions.get(position);
    if (sourceLine === undefined) {
      throw new Error(`images[${index}].position=${position} 不在目标正文可选位置中`);
    }
    // 兼容模型按旧协议/习惯返回 prompt 键的情况
    const tag = sanitizeContent(entry.tag ?? entry.prompt, 'tag', index);
    if (!tag) throw new Error(`images[${index}].tag 不能为空`);
    const nl = sanitizeContent(entry.nl, 'nl', index);
    const negative = sanitizeContent(entry.negative ?? entry.negative_prompt, 'negative', index);
    const characters = sanitizeCharacters(entry.characters, index);
    // 兼容模型按习惯返回 orientation / aspect 键
    const size = normalizeOrientation(entry.size ?? entry.orientation ?? entry.aspect);
    images.push({ position, sourceLine, tag, nl, negative, characters, size });
  }

  const limitedImages = images.slice(0, normalizedMax);
  if (limitedImages.length < normalizedMin) {
    throw new Error(
      `AI 返回了 ${limitedImages.length} 张图片，少于设置的最少图片数 ${normalizedMin}`,
    );
  }

  return {
    images: limitedImages,
    changes: parseChanges(parsed.changes, positions),
  };
}

/** 彩蛋采用独立返回字段,不会占用/挤掉正文图片名额。模型给的位置一律忽略。 */
export function parseBonusPlan(
  raw: string,
  segments: TargetSegment[],
  profile: { nl: boolean; naiCharPrompts: boolean; comic?: boolean },
): ImagePlan {
  const parsed = parseObject(raw);
  const bonus = parsed.bonus;
  if (!bonus || typeof bonus !== 'object' || Array.isArray(bonus)) {
    throw new Error('彩蛋缺失：请返回一个独立的 bonus 对象');
  }
  const last = segments[segments.length - 1];
  if (!last) throw new Error('没有可供彩蛋参考的正文');
  if (profile.comic) {
    const plan = parseComicPlan(JSON.stringify({ pages: [{ ...bonus, position: last.id }], changes: [] }), segments);
    plan.images[0].bonus = true;
    return plan;
  }
  const plan = parseImagePlan(JSON.stringify({
    images: [{ ...bonus, position: last.id }],
    changes: [],
  }), segments, 1, 1);
  const image = plan.images[0];
  if (profile.nl && (!image.nl || image.characters.some(character => !character.nl))) {
    throw new Error('彩蛋缺少本次要求的自然语言字段');
  }
  if (profile.naiCharPrompts && /\b\d+(?:girls?|boys?)\b/i.test(image.tag) && !image.characters.length) {
    throw new Error('彩蛋有人物但缺少独立角色块');
  }
  image.bonus = true;
  return plan;
}

/** 追加到写回时的真实正文末尾,兼容已有换行;原文本逐字保留。 */
export function appendBonusImage(source: string, image: ImageInsertion): string {
  const eol = source.match(/\r\n|\n|\r/)?.[0] ?? '\n';
  return `${source}${eol}${serializeImageTag({ ...image, bonus: true })}`;
}

/**
 * 漫画任务的输出:`{"pages":[{position,size,summary,items}],"changes":[…]}`。
 *
 * 整楼精选改编成几页,**页数与每页格数都不设硬上限**(用户明确不要写死;篇幅靠协议里的
 * 「通常 1～2 页」参考量引导,见 prompt.ts 漫画协议);
 * 只要求至少一页——零页等于这次分析白跑,交给 runner 重试。任一页分镜不合法即整体抛错
 * 重试:漫画是连续叙事,悄悄丢掉中间一页比重来一次更糟。
 * 页按正文位置稳定排序:AI 偶尔把页序写乱,插回正文时仍要跟着剧情走。
 */
export function parseComicPlan(raw: string, segments: TargetSegment[]): ImagePlan {
  const parsed = parseObject(raw);
  const pages = Array.isArray(parsed.pages) ? parsed.pages : parsed.images;
  if (!Array.isArray(pages)) throw new Error('AI 返回的 JSON 缺少 pages 数组');
  if (!pages.length) throw new Error('AI 没有画任何一页漫画');
  const positions = new Map(segments.map(segment => [segment.id, segment.sourceLine]));

  const images: ImageInsertion[] = pages.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`pages[${index}] 必须是对象`);
    }
    const entry = item as Record<string, unknown>;
    const position = sanitizePosition(entry.position ?? entry.id, index);
    const sourceLine = positions.get(position);
    if (sourceLine === undefined) {
      throw new Error(`pages[${index}].position=${position} 不在目标正文可选位置中`);
    }
    const layout = validateComicLayout(entry, `pages[${index}]`);
    const size = normalizeOrientation(entry.size ?? entry.orientation ?? entry.aspect);
    return { position, sourceLine, tag: '', nl: '', negative: '', characters: [], size, kind: 'comic', layout };
  });
  images.sort((left, right) => left.sourceLine - right.sourceLine);

  return { images, changes: parseChanges(parsed.changes, positions) };
}

/**
 * 解析变化生效位置。建档(new)缺位置不是错——它本就全楼生效;
 * 解析不出时回落到首个位置,只用于排序。
 */
function parsePosition(
  value: unknown,
  positions: Map<string, number>,
): { position: string; sourceLine: number } | null {
  const position = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!/^P\d+$/.test(position)) return null;
  const sourceLine = positions.get(position);
  if (sourceLine === undefined) return null;
  return { position, sourceLine };
}

function firstPosition(positions: Map<string, number>): { position: string; sourceLine: number } {
  for (const [position, sourceLine] of positions) return { position, sourceLine };
  return { position: '', sourceLine: 0 };
}

/** 建档字段:hair 与 eyes 是二次元身份锚点,缺任一条则该条建档不可用(调用方丢弃)。 */
function parseNewFields(raw: Record<string, unknown>): string | null {
  const fields: Partial<Record<CharTagField, string>> = {};
  for (const field of CHAR_TAG_FIELDS) {
    const value = raw[field];
    const text = typeof value === 'string' ? value.trim().replace(/[\r\n]+/g, ' ') : '';
    if (text) fields[field] = text;
  }
  if (!fields.hair || !fields.eyes) return null;
  return JSON.stringify(fields);
}

function parseChanges(raw: unknown, positions: Map<string, number>): CharChange[] {
  if (!Array.isArray(raw)) return [];
  const out: CharChange[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const o = item as Record<string, unknown>;
    const name = typeof o.name === 'string' ? o.name.trim() : '';
    const fieldRaw = typeof o.field === 'string' ? o.field.trim() : '';
    if (!name || !HISTORY_FIELDS.has(fieldRaw)) continue;
    const field = fieldRaw as CharTagHistoryField;
    const parsedPosition = parsePosition(o.position ?? o.at, positions);
    // 建档全楼生效,位置只作记录,缺失就回落首位;永久变化必须知道从哪生效,位置坏 = 丢弃
    if (!parsedPosition && field !== 'new') continue;
    const { position, sourceLine } = parsedPosition ?? firstPosition(positions);
    let value = typeof o.value === 'string' ? o.value.trim() : '';
    const fields =
      o.fields && typeof o.fields === 'object' && !Array.isArray(o.fields)
        ? (o.fields as Record<string, unknown>)
        : null;
    if (field === 'new') {
      const parsedFields = fields ? parseNewFields(fields) : null;
      if (!parsedFields) continue;
      value = parsedFields;
    }
    const nl = typeof o.nl === 'string' ? o.nl.trim() : '';
    const reason = typeof o.reason === 'string' ? o.reason.trim() : '';
    if (!value && !nl) continue;
    out.push({ name, field, value, nl: nl || undefined, reason, position, sourceLine });
  }
  return out;
}

/** 保持原文及原换行符不变，只在模型选择的位置 ID 对应源码行之后插入 tag。 */
export function injectImageTags(source: string, images: ImageInsertion[]): string {
  if (!images.length) return source;
  const lines = sourceLines(source);
  const byLine = new Map<number, ImageInsertion[]>();
  for (const image of images) {
    if (!Number.isInteger(image.sourceLine) || image.sourceLine < 0 || image.sourceLine >= lines.length) {
      throw new Error(`位置 ${image.position} 对应的原始物理行已失效`);
    }
    const line = image.sourceLine;
    const list = byLine.get(line) ?? [];
    list.push(image);
    byLine.set(line, list);
  }

  const fallbackEol = lines.find(line => line.eol)?.eol || '\n';
  let output = '';
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    output += line.text;
    const inserted = byLine.get(index) ?? [];
    const insertedEol = line.eol || fallbackEol;
    // 序列化口径见 st/imageTagRegex.ts 的 serializeImageTag（与手动编辑弹窗共用同一份，
    // 两处漂移会让「解析出的字段」与「落进正文的原文」对不上，而 promptHash 吃的是原文）。
    for (const image of inserted) {
      output += `${insertedEol}${serializeImageTag(image)}`;
    }
    output += line.eol;
  }
  return output;
}
