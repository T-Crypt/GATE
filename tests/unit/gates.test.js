import assert from 'node:assert/strict';
import { test } from 'node:test';

import { evidenceIsFresh } from '../../server/domain/gates.js';

test('evidence from another HEAD cannot satisfy a gate', () => {
  assert.equal(
    evidenceIsFresh({ headSha: 'old', fileScope: ['server/**'] }, 'new', []),
    false
  );
});

test('evidence remains fresh on its recorded HEAD', () => {
  assert.equal(
    evidenceIsFresh({ headSha: 'same', fileScope: ['server/**'] }, 'same', []),
    true
  );
});
