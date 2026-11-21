import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ context: null as any }));
vi.mock('@/st/context', () => ({ getContext: () => mocks.context }));

describe('兔宝绘设置增量兼容', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
    vi.stubGlobal('toastr', { info: vi.fn(), success: vi.fn(), error: vi.fn() });
  });

  it('旧版参数原值迁移为默认方案,保留完整URL、自定义提示词和原设置键', async () => {
    const module = await import('@/state/settings');
    const stored = JSON.parse(JSON.stringify(module.settings));
    delete stored.autoTag.bonus;
    delete stored.autoTag.worldbookPreset;
    stored.autoTag.minImages = 2; stored.autoTag.maxImages = 3; stored.autoTag.retryCount = 4;
    stored.autoTag.prompts.naiV5Thinking = '用户原文：本版每轮整楼规划保留彩蛋。';
    stored.autoTag.prompts.naiV5Spec = '用户原有规范';
    delete stored.nai.plans; delete stored.nai.activePlanId;
    Object.assign(stored.nai, { model: 'nai-diffusion-4-5-full', naturalLanguage: false,
      sampler: 'k_euler', cfgRescale: 0.3, noiseSchedule: 'karras', varietyBoost: true,
      normalizeRefStrength: false, orientationLock: 'landscape',
      qualityTags: 'original quality', undesiredContent: 'original negative', concurrency: 3 });
    stored.nai.steps = 37; stored.nai.scale = 7.5; stored.nai.seed = 123456;
    stored.nai.portraitSize = '1024×1536'; stored.nai.landscapeSize = '1536×1024';
    stored.nai.key = 'legacy-private-key';
    stored.nai.endpoints[0].key = 'official-private-key';
    stored.nai.endpoints.push({ id: 'nep_custom', name: '原公益站', url: 'http://example.test/image/custom', key: 'custom-private-key', directUrl: true });
    stored.nai.activeEndpointId = 'nep_custom';
    stored.channels = [{ id: 'ch_keep', name: '原副 API', url: 'https://example.test/v1', key: 'private-model-key', model: 'my-model', temperature: 0.7, maxTokens: 4096, timeoutSec: 600, reasoningEffort: 'high', stream: true, excludeParams: [] }];
    stored.assignments.tagGen = 'ch_keep';
    const { nai: legacyNai, ...otherSettings } = JSON.parse(JSON.stringify(stored));
    mocks.context = { extensionSettings: {
      baibai_image: stored,
      baibai_exclude_settings: { ...stored.excludes, schemaVersion: 1, revision: 1 },
    }, saveSettingsDebounced: vi.fn() };
    await module.hydrateSettings();
    const after = JSON.parse(JSON.stringify(module.settings));
    expect(after.autoTag.bonus).toEqual({ enabled: false, prompt: '' });
    delete after.autoTag.bonus;
    expect(after.autoTag.worldbookPreset).toBe('builtin');
    delete after.autoTag.worldbookPreset;
    const { nai: migratedNai, ...otherAfter } = after;
    expect(otherAfter).toEqual(otherSettings);
    expect(migratedNai.plans).toHaveLength(1);
    expect(migratedNai.plans[0]).toMatchObject({ model: legacyNai.model, naturalLanguage: false,
      steps: 37, scale: 7.5, seed: 123456, sampler: 'k_euler', cfgRescale: 0.3,
      noiseSchedule: 'karras', varietyBoost: true, normalizeRefStrength: false,
      orientationLock: 'landscape', qualityTags: 'original quality', undesiredContent: 'original negative',
      portraitSize: '1024×1536', landscapeSize: '1536×1024', endpointId: 'nep_custom' });
    expect(migratedNai.endpoints.find((e: any) => e.id === 'nep_custom')).toMatchObject({ directUrl: true, key: 'custom-private-key', concurrency: 3 });
    expect(migratedNai.endpoints.find((e: any) => e.id === 'nep_official').key).toBe('official-private-key');
    expect(mocks.context.extensionSettings.tubao_image).toBeUndefined();
    expect(module.effectiveNai().directUrl).toBe(true);
    expect(module.effectiveNai().url).toBe('http://example.test/image/custom');
  });

  it('喵喵来源选择可以恢复,原自定义提示词与彩蛋设置不覆盖', async () => {
    mocks.context = { extensionSettings: { baibai_image: { autoTag: {
      worldbookPreset: 'miaomiao', minImages: 2, maxImages: 3,
      prompts: { naiV5Thinking: '原自定义内容' },
      bonus: { enabled: true, prompt: '用户原彩蛋备注' },
    } } }, saveSettingsDebounced: vi.fn() };
    const { hydrateSettings, settings } = await import('@/state/settings');
    await hydrateSettings();
    expect(settings.autoTag.worldbookPreset).toBe('miaomiao');
    expect(settings.autoTag.prompts.naiV5Thinking).toBe('原自定义内容');
    expect(settings.autoTag.bonus).toEqual({ enabled: true, prompt: '用户原彩蛋备注' });
    expect(settings.autoTag.minImages).toBe(2);
    expect(settings.autoTag.maxImages).toBe(3);
  });

  it('开关和独立彩蛋说明可持久恢复,不影响原来正文图数量', async () => {
    mocks.context = { extensionSettings: { baibai_image: { autoTag: {
      minImages: 0, maxImages: 3, bonus: { enabled: true, prompt: '保留这段独立彩蛋说明' },
    } } }, saveSettingsDebounced: vi.fn() };
    const { hydrateSettings, settings } = await import('@/state/settings');
    await hydrateSettings();
    expect(settings.autoTag.bonus).toEqual({ enabled: true, prompt: '保留这段独立彩蛋说明' });
    expect(settings.autoTag.maxImages).toBe(3);
    expect(settings.autoTag.minImages).toBe(0);
  });
});
