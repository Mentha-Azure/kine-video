// @kine/agent — kine.impact：改动影响分析（依赖图闭包：invalidates/keeps/reruns）
import { parseTargetPath } from '@kine/dsl';
import { fail, ok, type ToolResult } from '../types';
import type { AgentContext } from '../context';
import { impactOf } from './util';

export interface ImpactArgs {
  paths: string[];
}

export async function toolImpact(ctx: AgentContext, args: ImpactArgs): Promise<ToolResult> {
  const { ir } = ctx.compile();
  const paths = args.paths ?? [];
  if (paths.length === 0) {
    return fail('impact', 'E-TX-006', '缺少改动目标：至少给一个 DSL 路径（如 scenes[title].layers[glitch_title].props.flash_period）', {
      hints: ['先 kine find/explain 定位元素，再对候选路径做 impact 预判'],
      nextActions: [{ tool: 'kine.find', args: { query: '...' } }],
    });
  }
  const targets = paths.map((p) => parseTargetPath(p));
  const unknown = targets.filter((t) => t.kind === 'unknown');
  if (unknown.length > 0) {
    const bad = paths.filter((_, i) => targets[i].kind === 'unknown');
    return fail('impact', 'E-TX-004', `无法解析路径：${bad.join(', ')}`, {
      hints: ['路径语法：scenes[幕id].layers[层id].字段 / theme.post.xxx / output.duration / pace.segments[i].ratio'],
      facts: [`已知幕：${ir.scenes.map((s) => s.id).join(', ')}`],
    });
  }
  const impact = impactOf(ir, targets);
  const facts: string[] = [];
  facts.push(`改动 ${paths.length} 处：${paths.join('; ')}`);
  facts.push(`失效（invalidates）${impact.invalidates.length} 项：${impact.invalidates.slice(0, 8).join(', ')}${impact.invalidates.length > 8 ? ' …' : ''}`);
  if (impact.keeps.length) facts.push(`保留（keeps）${impact.keeps.length} 项：${impact.keeps.slice(0, 6).join('; ')}${impact.keeps.length > 6 ? ' …' : ''}`);
  facts.push(`预计重渲：${impact.approx.rerender}（${impact.approx.frames} 帧）；音频：${impact.approx.remix}`);
  for (const w of impact.warnings) facts.push(`⚠ ${w}`);
  return ok(
    'impact',
    { paths, targets, impact },
    {
      verdict: 'PASS',
      facts,
      hints: impact.warnings.length ? ['影响范围包含方向性决策，先与用户确认再应用'] : undefined,
      nextActions: [
        { tool: 'kine.edit', args: { paths, tx: true, quote: '（用户原话）' }, reason: '按影响范围应用改动并记录事务' },
      ],
    },
  );
}
