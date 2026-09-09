process.stdin.setEncoding('utf8');
let input = '';
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  const textPart = (text, timestamp) => JSON.stringify({
    type: 'text',
    timestamp,
    sessionID: 'ses_test',
    part: { type: 'text', text, time: { start: timestamp, end: timestamp + 1 } }
  });
  const echo = textPart(input, 0);
  const isDraft = input.includes('Create a concise implementation timeline');
  const answer = isDraft
    ? textPart(
        JSON.stringify({
          nodes: [{ id: 'draft-m', key: 'A', kind: 'milestone', title: 'Build', ordinal: 0 }],
          edges: [],
          gates: []
        }),
        1
      )
    : textPart('implemented the step', 1);
  process.stdout.write(`${echo}\n${answer}\n`);
});