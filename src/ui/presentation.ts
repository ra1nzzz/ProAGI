import type { ImportCommit } from '../application/insightService';
import type { WorkModelClaim } from '../domain/types';
import type { ReplaySnapshotV1 } from '../domain/replay';
import type { DemoViewModel } from './demoViewModel';

export function buildInsightPresentation(commit: ImportCommit | null, liveClaim?: WorkModelClaim | null, replaySnapshot?: ReplaySnapshotV1 | null): DemoViewModel {
  if (!commit) return emptyPresentation;
  const output = commit.output;
  const baseClaim = output.claims[0];
  const claim = liveClaim === undefined ? baseClaim : liveClaim;
  const replayOutput = replaySnapshot?.output ?? output;
  const replayClaim = replayOutput.claims[0];
  const questions = output.questions.map((question) => ({
    eyebrow: '需要确认', title: question.prompt, detail: `${question.gapType} · 预计信息增益 ${question.expectedInformationGain.toFixed(2)}`, action: '审阅问题',
  }));
  const shadows = output.actionIntents.map((intent) => ({
    eyebrow: 'SHADOW 建议', title: intent.summary, detail: '仅显示假设步骤；不会执行外部动作。', action: '预览建议',
  }));
  return {
    today: {
      dateLabel: `${output.report.localDate} · 本地测试数据`,
      headline: `已从 ${output.events.length} 条事件整理出 ${output.episodes.length} 个工作片段。`,
      summary: '以下内容直接来自本地 canonical output；不会连接真实桌面、Runtime 或外部服务。',
      metrics: [
        { label: '测试 Episode', value: String(output.episodes.length) },
        { label: 'Live Insight', value: String(claim && claim.status !== 'rejected' ? 1 : 0) },
        { label: '真实副作用', value: '0' },
      ],
    },
    observed: output.episodes.map((episode) => ({
      time: `${timePart(episode.startAt)}–${timePart(episode.endAt)}`,
      title: episode.title,
      detail: `${episode.eventIds.length} 条 allowlisted 测试事件`,
      kind: episode.activityKind,
    })),
    learned: {
      statement: claim?.statement ?? '证据不足，尚未形成 Insight。',
      confidence: claim ? statusLabel(claim.status) : '无结论',
      confidenceValue: claim ? claim.confidence.toFixed(2) : '0.00',
      scope: claim ? [claim.scope.projectKey, claim.scope.activityKind].filter(Boolean).join(' / ') : '未确定',
      evidence: claim ? `${claim.evidence.length} 条 evidence ref` : '0 条',
      counterEvidence: claim ? `${claim.counterEvidence.length} 条 counter-evidence ref` : '0 条',
    },
    correction: {
      before: baseClaim?.statement ?? '无初始 Insight',
      after: claim?.statement ?? '该 Insight 已删除',
      impact: claim && baseClaim && claim.id !== baseClaim.id ? `revision ${claim.revision} · ${statusLabel(claim.status)}` : '尚未提交用户纠正',
    },
    inbox: [...questions, ...shadows],
    replay: {
      fixture: 'developer-day-bundled-v1',
      scope: replayClaim ? [replayClaim.scope.projectKey, replayClaim.scope.activityKind].filter(Boolean).join(' / ') : '无 live scope',
      before: baseClaim?.statement ?? '无初始输出',
      after: replayClaim?.statement ?? '无 live 输出',
      hash: (replaySnapshot?.snapshotHash ?? output.snapshotHash).slice(0, 22),
    },
  };
}

const emptyPresentation: DemoViewModel = {
  today: {
    dateLabel: '尚无本地数据', headline: '等待你导入 bundled synthetic fixture。',
    summary: '导入前不展示示例结论，也不暗示已经观察真实桌面。',
    metrics: [
      { label: '测试 Episode', value: '0' },
      { label: 'Live Insight', value: '0' },
      { label: '真实副作用', value: '0' },
    ],
  },
  observed: [],
  learned: {
    statement: '证据不足，尚未形成 Insight。', confidence: '无结论', confidenceValue: '0.00', scope: '未确定', evidence: '0 条', counterEvidence: '0 条',
  },
  correction: { before: '无初始 Insight', after: '无用户 revision', impact: '尚未提交用户纠正' },
  inbox: [],
  replay: { fixture: '尚未导入', scope: '无 live scope', before: '无初始输出', after: '无 live 输出', hash: '无 snapshot' },
};

function timePart(timestamp: string): string {
  return timestamp.slice(11, 16);
}

function statusLabel(status: WorkModelClaim['status']): string {
  return ({ proposed: '待审阅', confirmed: '已确认', rejected: '已驳回', invalidated: '已失效' } as const)[status];
}
