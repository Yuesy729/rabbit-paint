import { beforeEach, describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import * as Vue from 'vue';
import { createRenderer, nextTick, ssrContextKey, defineComponent, h } from 'vue';
import { compileScript, compileTemplate, parse } from 'vue/compiler-sfc';
import NaiPanel from '@/pages/backend/panels/NaiPanel.vue';
import { settings, newNaiPlan, activeNaiPlan } from '@/state/settings';
vi.mock('@/st/context',()=>({getContext:()=>({extensionSettings:{}})}));
vi.mock('@/components/Icon.vue',()=>({default:()=>null}));
vi.mock('@/pages/backend/panels/NaiArtistLibrary.vue',()=>({default:()=>null}));
vi.mock('@/pages/backend/panels/NaiArtistPicker.vue',()=>({default:()=>null}));
vi.mock('@/components/Collapsible.vue',()=>({default:{props:['title','open'],setup:(p:any,{slots}:any)=>()=>h('section',{'data-title':p.title,'data-open':p.open!==false},slots.default?.())}}));
vi.mock('@/components/ModalMask.vue',()=>({default:{props:['open'],setup:(p:any,{slots}:any)=>()=>p.open?h('aside',{},slots.default?.()):null}}));
vi.mock('@/components/BbiSelect.vue',()=>({default:{props:['modelValue','options','ariaLabel'],emits:['update:modelValue'],setup:(p:any,{emit}:any)=>()=>h('select',{'aria-label':p.ariaLabel,value:p.modelValue,onChange:(e:any)=>emit('update:modelValue',e.target.value)})}}));
vi.mock('@/components/BbiTextarea.vue',()=>({default:()=>null}));
vi.mock('vue',async original=>{const v=await original<typeof import('vue')>();return {...v,vModelText:{},vModelCheckbox:{},vModelSelect:{}}});
const {descriptor}=parse(readFileSync(new URL('./NaiPanel.vue',import.meta.url),'utf8'));
const compiled=compileTemplate({source:descriptor.template!.content,filename:'NaiPanel.vue',id:'nai-ui',compilerOptions:{mode:'function',bindingMetadata:compileScript(descriptor,{id:'nai-ui'}).bindings}});
if(compiled.errors.length)throw new Error(compiled.errors.join('\n'));
const Panel={...NaiPanel,render:new Function('Vue',ts.transpileModule(compiled.code,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText)(Vue)};
interface TestNode {
  type: string;
  text: string;
  props: Record<string, unknown>;
  children: TestNode[];
  parent: TestNode | null;
}

function node(type: string, text = ''): TestNode {
  return { type, text, props: {}, children: [], parent: null };
}

function remove(child: TestNode): void {
  if (!child.parent) return;
  child.parent.children.splice(child.parent.children.indexOf(child), 1);
  child.parent = null;
}

function insert(child: TestNode, parent: TestNode, anchor?: TestNode | null): void {
  remove(child);
  parent.children.splice(anchor ? parent.children.indexOf(anchor) : parent.children.length, 0, child);
  child.parent = parent;
}

// A small in-memory host lets the existing Node test suite count actual Vue-rendered nodes.
const renderer = createRenderer<TestNode, TestNode>({
  createElement: type => node(type),
  createText: text => node('#text', text),
  createComment: text => node('#comment', text),
  setText: (target, text) => { target.text = text; },
  setElementText: (target, text) => { target.text = text; target.children = []; },
  patchProp: (target, key, _previous, value) => { target.props[key] = value; },
  parentNode: target => target.parent,
  nextSibling: target => {
    const siblings = target.parent?.children ?? [];
    return siblings[siblings.indexOf(target) + 1] ?? null;
  },
  insert,
  remove,
  insertStaticContent: (content, parent, anchor) => {
    const target = node('#static', content);
    insert(target, parent, anchor);
    return [target, target];
  },
});

function find(root: TestNode, selector: string): TestNode[] {
  const matches = selector.startsWith('.')
    ? String(root.props.class ?? '').split(' ').includes(selector.slice(1))
    : root.type === selector;
  return [...(matches ? [root] : []), ...root.children.flatMap(child => find(child, selector))];
}


function matches(root:TestNode,key:string,value:unknown):TestNode[]{return [...(root.props[key]===value?[root]:[]),...root.children.flatMap(c=>matches(c,key,value))]}
function mount(){const root=node('root');const app=renderer.createApp(Panel);app.provide(ssrContextKey,{});app.mount(root);return {root,app}}
function choose(root:TestNode,label:string,value:string){const el=matches(root,'aria-label',label)[0];expect(el,`存在页内${label}`).toBeTruthy();(el.props.onChange as any)({target:{value}})}
beforeEach(()=>{vi.stubGlobal('toastr',{info:vi.fn(),error:vi.fn(),success:vi.fn(),warning:vi.fn()});settings.nai.artistPresets=[{id:'art_a',name:'A',prompt:'artist:a',quality:'a quality',negative:'a negative'},{id:'art_b',name:'B',prompt:'artist:b',quality:'b quality',negative:'b negative'}];const first={...newNaiPlan('当前'),artistId:'art_a',steps:27,scale:6,seed:12345,qualityTags:'keep quality',undesiredContent:'keep negative'};settings.nai.plans=[first,{...newNaiPlan('其它'),artistId:'art_a',steps:35}];settings.nai.activePlanId=first.id});
describe('旧版页内切换操作与新版数据隔离',()=>{
 it('打开界面不改任何保存值,页内提示词直接可用且方案管理默认收起',async()=>{const before=JSON.stringify(settings);const {root,app}=mount();await nextTick();expect(JSON.stringify(settings)).toBe(before);expect(matches(root,'data-title','提示词')[0].props['data-open']).toBe(true);expect(matches(root,'data-title','方案管理')[0].props['data-open']).toBe(false);expect(matches(root,'aria-label','当前画师串')).toHaveLength(1);app.unmount()});
 it('下拉选择只修改当前画师引用,不套用正负面词或更改其它参数和方案',async()=>{const {root,app}=mount();const before=JSON.parse(JSON.stringify(settings));choose(root,'当前画师串','art_b');await nextTick();before.nai.plans[0].artistId='art_b';expect(JSON.parse(JSON.stringify(settings))).toEqual(before);expect(matches(root,'aria-label','当前画师串')[0].props.value).toBe('art_b');choose(root,'当前画师串','');await nextTick();expect(activeNaiPlan().artistId).toBe('');app.unmount()});
 it('后台编辑其它方案时,页内下拉仍修改当前出图方案',async()=>{const {root,app}=mount();const edits=matches(root,'aria-label','编辑这套方案');(edits[1].props.onClick as any)();await nextTick();const other=JSON.stringify(settings.nai.plans[1]);choose(root,'当前画师串','art_b');await nextTick();expect(activeNaiPlan().artistId).toBe('art_b');expect(JSON.stringify(settings.nai.plans[1])).toBe(other);expect(matches(root,'aria-label','方案使用的接入点')).toHaveLength(1);app.unmount()});
});
