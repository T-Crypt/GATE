// The single description of the timeline shape Gate's providers must return.
//
// `normalizeTimelineGraph` (server/application/timeline-service.js) is the
// authority on what Gate accepts. Everything here must stay aligned with it:
// a draft that satisfies this schema must survive normalization, otherwise the
// provider round-trips for ~30s and the draft is rejected before it is stored.

const NODE_KINDS = ['milestone', 'step'];
const EDGE_TYPES = [
  'depends_on',
  'code_gate',
  'test_gate',
  'build_gate',
  'plan_gate',
  'visual_gate',
  'approval_gate'
];
const GATE_KINDS = ['code', 'test', 'build', 'plan', 'visual', 'approval'];

export const timelineSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['nodes', 'edges', 'gates'],
  properties: {
    nodes: {
      type: 'array',
      minItems: 2,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'key', 'kind', 'title'],
        properties: {
          id: { type: 'string', description: 'Stable id referenced by parentId, edges, and gates' },
          key: { type: 'string', description: 'Short unique display key, e.g. M1 or M1.2' },
          kind: { type: 'string', enum: NODE_KINDS },
          title: { type: 'string' },
          description: { type: 'string' },
          parentId: {
            type: ['string', 'null'],
            description: 'Required on step nodes: the id of the milestone node it belongs to'
          },
          ordinal: { type: 'integer' }
        }
      }
    },
    edges: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['fromNodeId', 'toNodeId', 'type'],
        properties: {
          fromNodeId: { type: 'string' },
          toNodeId: { type: 'string' },
          type: { type: 'string', enum: EDGE_TYPES }
        }
      }
    },
    gates: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['nodeId', 'type', 'title'],
        properties: {
          nodeId: { type: 'string' },
          type: { type: 'string', enum: GATE_KINDS },
          title: { type: 'string' },
          blocking: { type: 'boolean' },
          requiredEvidence: { type: 'array', items: { type: 'string' } }
        }
      }
    }
  }
};

// Providers without native JSON-schema support get the same contract as prose.
export const timelineContractPrompt = [
  'Return a single JSON object with exactly these keys: "nodes", "edges", "gates".',
  '',
  'nodes[]: { "id": string, "key": string, "kind": "milestone" | "step", "title": string,',
  '  "description": string, "parentId": string | null, "ordinal": integer }',
  '  - id and key must both be unique across all nodes.',
  '  - every node with kind "step" must set parentId to the id of a milestone node.',
  '  - milestone nodes set parentId to null.',
  '',
  `edges[]: { "fromNodeId": string, "toNodeId": string, "type": one of ${EDGE_TYPES.join(' | ')} }`,
  '  - fromNodeId and toNodeId must be node ids that exist in nodes[].',
  '  - the edge set must be acyclic.',
  '',
  `gates[]: { "nodeId": string, "type": one of ${GATE_KINDS.join(' | ')}, "title": string,`,
  '  "blocking": boolean, "requiredEvidence": string[] }',
  '  - nodeId must be a node id that exists in nodes[].'
].join('\n');

export function buildTimelinePrompt({ goal, repositoryContext }) {
  return [
    'Create a concise implementation timeline for the following local repository goal.',
    'Return milestones and executable steps. Add code, test, visual, or approval gates where evidence is required.',
    `Goal: ${goal}`,
    `Repository context: ${repositoryContext || 'No additional context supplied.'}`,
    timelineContractPrompt
  ].join('\n\n');
}
