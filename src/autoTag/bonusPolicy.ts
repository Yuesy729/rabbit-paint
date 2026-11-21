import { DEFAULT_BONUS_PROMPT, type AutoTagSettings } from '@/state/settings';

export type TagTaskMode = 'story' | 'slot' | 'bonus' | 'bonus-slot';

/** 最终任务边界:普通插图与彩蛋分开请求,旧自定义提示词不参与修改。 */
export function storyOutputPolicy(options: AutoTagSettings, mode: TagTaskMode): string {
  if (mode === 'bonus' || !options.bonus) return '';
  if (mode === 'slot' || mode === 'bonus-slot') {
    return '【本次任务边界】只重写指定图片,images 恰好一项；bonus 为 null。保留目标图片原有画面及风格。本次不创建额外彩蛋,旧自定义提示词里的彩蛋数量与追加要求不适用于本次任务。';
  }
  return `【本次任务边界】本次只规划正文插图。images 的数量范围是 ${options.minImages}～${options.maxImages},全部名额属于正文图。bonus 为 null。${options.bonus.enabled ? '额外彩蛋由程序在另一项独立请求中生成,不能占用本次 images 的名额。' : '末尾彩蛋开关已关闭,本次不生成彩蛋。'}旧自定义提示词中关于额外彩蛋、预留名额、末项为彩蛋或合计张数的要求不适用于本次任务；其余绘图规范照常执行。`;
}

export function bonusOutputContract(options: AutoTagSettings, nl: boolean, nativeCharacters: boolean): string {
  return `你正在执行兔宝绘的独立末尾彩蛋任务。本次只返回一个完整的彩蛋画面,不生成常规正文图、不重写正文、不更新角色档案。
${options.worldbookPreset === 'miaomiao' ? '本次生图结果为一个可解析的 JSON 对象；在它前面输出独立选景清单与逐图核对结果,具体标签按末尾流程约定,不使用 Markdown 围栏：' : '本次唯一输出为一个可解析的 JSON 对象,不使用 Markdown 围栏、不输出思考过程：'}
{"images":[],"changes":[],"bonus":{"tag":"英文 Base 提示词"${nl ? ',"nl":"English Base description"' : ''},${nativeCharacters ? '"characters":[{"name":"角色原名","tag":"该角色提示词"' + (nl ? ',"nl":"English character description"' : '') + '}],' : ''}"size":"portrait"}}
bonus 必须是一个非空对象。tag 为英文逗号分隔的短词；${nl ? 'Base 和每个角色都必须带非空的英文 nl。' : '本次不输出 nl 字段。'}${nativeCharacters ? '使用 Base + 独立 characters 数组；人物外貌、服装和个人动作写在对应角色块,角色原名逐字保留。' : '按当前后端规范编写画面提示词。'}画幅方向服从当前渠道规则。
程序负责把彩蛋放在正文末尾,你不需要输出 position。忽略上下文中针对正文 images 的张数、选段与逐张检查要求。彩蛋允许采用下面说明指定的非正史视觉演绎,该允许只适用于此独立 bonus 字段,不将其视为正文事实,不报告 changes。
角色可辨识外貌和身份以角色设定、角色库及本轮常规图参考为依据。
【彩蛋内容说明】
${options.bonus?.prompt.trim() || (options.worldbookPreset === 'miaomiao' ? '见本次导入的喵喵彩蛋条目。' : DEFAULT_BONUS_PROMPT)}`;
}
