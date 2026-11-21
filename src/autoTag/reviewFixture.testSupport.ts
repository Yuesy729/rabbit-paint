/** 中性模拟响应,供协议与请求集成测试使用,不调用模型。 */
export function withSceneReview(raw: string): string {
  const value = JSON.parse(raw);
  const bonus = !!value.bonus;
  const images = bonus ? [value.bonus] : value.images;
  const scenes = images.map((image: any, index: number) => ({
    index: index + 1, position: bonus ? 'END' : image.position,
    focus: '取景与人物互动', participants: (image.characters ?? []).map((character: any) => character.name),
  }));
  const reviews = images.map((image: any, index: number) => {
    const chars = image.characters ?? [];
    const base = [['tag', image.tag.split(',')[0].trim()]];
    const refs = chars.map((character: any, i: number) => [`characters[${i}].tag`, character.tag.split(',')[0].trim()]);
    const items = {
      '1': base, '2': 'ok', '3': chars.length ? refs : 'na:无人物入镜',
      '4': chars.length > 1 ? [...base, ...refs] : 'na:无多人互动',
      '5': 'ok', '6': 'ok', '7': 'ok', '8': 'ok', '9': [...base, ...refs],
      '10': 'ok', '11': 'na:当前测试场景不适用', '13': 'ok',
    };
    return `<image_check index="${index + 1}">${JSON.stringify({ items })}</image_check>`;
  });
  return [`<scene_plan>${JSON.stringify({ scenes })}</scene_plan>`, ...reviews, raw].join('\n');
}
