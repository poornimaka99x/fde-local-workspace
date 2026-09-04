export const claudeSession = {
  provider: 'claude',
  profile: 'work',
  sessionId: null,
  resumable: true,
  resumeReason: null,
}

export const codexSession = {
  provider: 'codex',
  profile: null,
  sessionId: null,
  resumable: false,
  resumeReason: 'Resume this run in its original Codex task',
}

export const runRows = [
  {
    runId: '20260901-max-1-aaaa',
    state: 'research',
    projectId: 'returns-a1b2',
    requirement: 'MAX-1 returns research',
    jiraKey: 'MAX-1',
    updatedAt: '2026-09-01T10:00:00+00:00',
    orchestrator: { agentId: 'claude_work', label: 'Claude: work', kind: 'claude' },
    session: claudeSession,
  },
  {
    runId: '20260902-max-2-bbbb',
    state: 'complete',
    projectId: null,
    requirement: 'MAX-2 legacy run',
    jiraKey: 'MAX-2',
    updatedAt: '2026-09-02T10:00:00+00:00',
    orchestrator: { agentId: 'chatgpt_codex', label: 'ChatGPT/Codex', kind: 'codex' },
    session: codexSession,
  },
]

export function statusFixture(runId: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    runId,
    dir: `/tmp/${runId}`,
    manifest: { runId, state: 'research' },
    state: 'research',
    blockedFrom: null,
    projectId: null,
    project: null,
    requirement: { summary: 'do the thing', jiraKey: null, hasFile: true, path: 'requirement.md' },
    plan: { stages: ['intake', 'research'] },
    planLine: 'intake → research',
    stageTimeline: [{ stage: 'research', label: 'research', state: 'current' }],
    sequence: ['intake', 'research'],
    nextState: null,
    nextAction: 'fde resume … --next',
    roles: { confirmed: true, confirmedAt: null, selectedAt: null, orchestrator: null, assignments: [] },
    approvals: [],
    checkpoints: [],
    events: { total: 120, offset: 70, limit: 50, returned: 50, nextCursor: null, items: [] },
    artifacts: { expected: [], discovered: [], truncated: false },
    attachments: [],
    outputHygiene: null,
    session: claudeSession,
    warnings: [],
  }
}
