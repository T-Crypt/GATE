import assert from 'node:assert/strict';
import { test } from 'node:test';

import { planWarningPanel, planningReview, stalenessBadge } from '../../public/js/features.js';

function plan(overrides = {}) {
  return {
    id: 'plan-1',
    goal: 'Change provider cancellation',
    status: 'accepted',
    impact: { directMatches: [], dependents: [], tests: [], risk: 'low' },
    draft: { graph: { nodes: [] } },
    context: { estimatedTokens: 100, tokenBudget: 4000 },
    provenance: { memoryRevisionSha: 'abcdef0123456789' },
    ...overrides
  };
}

test('each staleness state renders a distinct status class', () => {
  assert.match(stalenessBadge('CURRENT'), /badge staleness current/);
  assert.match(stalenessBadge('POSSIBLY_STALE'), /badge staleness possibly_stale/);
  assert.match(stalenessBadge('STALE'), /badge staleness stale/);
  // An unrecognised status must not silently inherit a colour that claims
  // the plan is current.
  assert.match(stalenessBadge('WAT'), /badge staleness unknown/);
});

test('a stale plan offers re-grounding and a current one does not', () => {
  const stale = planningReview(plan(), {
    status: 'STALE',
    reason: '1 file this plan was grounded on changed: src/provider.js.',
    changedGroundingFiles: ['src/provider.js']
  });
  assert.match(stale, /badge staleness stale/);
  assert.match(stale, /data-reground-plan="plan-1"/);
  assert.match(stale, /src\/provider\.js/);

  const current = planningReview(plan(), {
    status: 'CURRENT',
    reason: 'The repository has not moved since this plan was grounded.'
  });
  assert.match(current, /badge staleness current/);
  assert.equal(current.includes('data-reground-plan'), false);
});

test('the pre-execution warning panel renders every warning with a re-ground action', () => {
  assert.equal(planWarningPanel([]), '');
  const panel = planWarningPanel([
    {
      planningRequestId: 'plan-1',
      status: 'STALE',
      reason: '1 file this plan was grounded on changed: src/provider.js.',
      changedGroundingFiles: ['src/provider.js']
    },
    {
      planningRequestId: 'plan-2',
      status: 'POSSIBLY_STALE',
      reason: 'The repository moved but no grounding file changed.',
      changedGroundingFiles: []
    }
  ]);
  assert.match(panel, /data-testid="plan-warnings"/);
  assert.match(panel, /data-reground-plan="plan-1"/);
  assert.match(panel, /data-reground-plan="plan-2"/);
  assert.match(panel, /2 runs started against drifted plans/);
  assert.match(panel, /The run was not blocked/);
});

test('warning text from the repository is escaped, not interpolated', () => {
  const panel = planWarningPanel([
    {
      planningRequestId: '"><script>x</script>',
      status: 'STALE',
      reason: '<img src=x onerror=alert(1)>',
      changedGroundingFiles: ['<b>src/provider.js</b>']
    }
  ]);
  assert.equal(panel.includes('<script>'), false);
  assert.equal(panel.includes('<img src=x'), false);
  assert.equal(panel.includes('<b>src/provider.js</b>'), false);
  assert.match(panel, /&lt;img src=x/);
});
