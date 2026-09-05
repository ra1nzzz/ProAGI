export type OrbState =
  | 'LEARNING'
  | 'EXECUTING'
  | 'IDLE'
  | 'SUGGESTION'
  | 'PRIVATE'
  | 'ERROR';

export type ContentMode = 'content' | 'empty' | 'stale';

export interface DemoViewModel {
  today: {
    dateLabel: string;
    headline: string;
    summary: string;
    metrics: readonly { label: string; value: string }[];
  };
  observed: readonly {
    time: string;
    title: string;
    detail: string;
    kind: string;
  }[];
  learned: {
    statement: string;
    confidence: string;
    confidenceValue: string;
    scope: string;
    evidence: string;
    counterEvidence: string;
  };
  correction: {
    before: string;
    after: string;
    impact: string;
  };
  inbox: readonly {
    eyebrow: string;
    title: string;
    detail: string;
    action: string;
  }[];
  replay: {
    fixture: string;
    scope: string;
    before: string;
    after: string;
    hash: string;
  };
}

export const ORB_STATES: readonly OrbState[] = [
  'LEARNING',
  'EXECUTING',
  'IDLE',
  'SUGGESTION',
  'PRIVATE',
  'ERROR',
];

export const ORB_STATE_LABELS: Readonly<Record<OrbState, string>> = {
  LEARNING: '正在学习本地测试证据',
  EXECUTING: '正在本地导入或重放',
  IDLE: '本地观察已就绪',
  SUGGESTION: '有一条建议待审阅',
  PRIVATE: '隐私模式已开启',
  ERROR: '恢复需要你的处理',
};

export const ORB_STATE_ICONS: Readonly<Record<OrbState, string>> = {
  LEARNING: '✦',
  EXECUTING: '↻',
  IDLE: '◉',
  SUGGESTION: '◆',
  PRIVATE: '▣',
  ERROR: '!',
};

export const demoViewModel: DemoViewModel = {
  today: {
    dateLabel: '今天 · 本地演示',
    headline: '工程上下文已整理，等待你的判断。',
    summary: '系统仅使用仓库内的测试样例生成此页面；未连接真实桌面、Runtime 或外部服务。',
    metrics: [
      { label: '测试 Episode', value: '3' },
      { label: '待审阅 Insight', value: '2' },
      { label: '真实副作用', value: '0' },
    ],
  },
  observed: [
    { time: '09:12–09:46', title: '回归测试与定位', detail: '测试运行 → 查看失败摘要 → 回到编辑器', kind: '测试事件' },
    { time: '10:04–10:38', title: '修订知识规则', detail: '审阅证据 → 编辑适用范围 → 本地 Replay', kind: '测试事件' },
    { time: '11:02–11:18', title: '整理工程结算', detail: '聚合 Episode → 生成日报投影', kind: '测试事件' },
  ],
  learned: {
    statement: '在修改共享契约后，你通常会先运行定向测试，再执行完整回归。',
    confidence: '中等信心',
    confidenceValue: '0.72',
    scope: '测试项目 · 契约变更',
    evidence: '2 个测试 Episode 支持该结论',
    counterEvidence: '1 次仅运行定向测试，尚未观察到完整回归',
  },
  correction: {
    before: '修改契约后总是立即运行完整回归。',
    after: '修改共享契约后，先运行定向测试，再运行完整回归。',
    impact: '仅影响“测试项目 / 契约变更”范围；其他工作模式保持不变。',
  },
  inbox: [
    { eyebrow: '需要确认', title: '“共享契约”是否只指跨模块类型？', detail: '回答会缩小规则范围，不会触发任何外部动作。', action: '审阅问题' },
    { eyebrow: 'Shadow 建议', title: '把回归顺序保存为检查清单', detail: '只预览建议内容；不会写文件或运行命令。', action: '预览建议' },
  ],
  replay: {
    fixture: 'fixture: correction-held-out-02',
    scope: '测试项目 / 契约变更',
    before: '命中旧规则：立即运行完整回归',
    after: '命中新规则：先定向测试，再完整回归',
    hash: 'sha256:82a4…d190',
  },
};
