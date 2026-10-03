import { describe, expect, it } from 'vitest';

import { indexA2aRunTags, nearestA2aSentTag, type DelegationLedgerRow } from './delegations.js';

function row(overrides: Partial<DelegationLedgerRow>): DelegationLedgerRow {
  return {
    id: 1,
    ts: '2026-08-07T07:30:00.000Z',
    from_group: 'ag-source',
    to_group: 'ag-target',
    from_session: 'sess-source',
    to_session: 'sess-target',
    a2a_msg_id: 'a2a-1',
    in_reply_to: null,
    tier: null,
    escalation: null,
    summary: 'Research the route.',
    file_count: 0,
    ...overrides,
  };
}

describe('A2A Runs tags', () => {
  it('indexes durable ledger rows as source and destination tags for both runs', () => {
    const indexed = indexA2aRunTags([
      row({}),
      row({
        id: 2,
        ts: '2026-08-07T07:40:00.000Z',
        a2a_msg_id: 'a2a-2',
        in_reply_to: 'a2a-1',
        from_group: 'ag-target',
        to_group: 'ag-source',
        from_session: 'sess-target',
        to_session: 'sess-source',
        summary: 'Completed the research.',
        file_count: 1,
      }),
    ]);

    expect(indexed.get('ag-source:sess-source')).toEqual([
      expect.objectContaining({ direction: 'sent', sourceGroupId: 'ag-source', destinationGroupId: 'ag-target' }),
      expect.objectContaining({ direction: 'received', sourceGroupId: 'ag-target', destinationGroupId: 'ag-source' }),
    ]);
    expect(indexed.get('ag-target:sess-target')).toEqual([
      expect.objectContaining({ direction: 'received', sourceGroupId: 'ag-source', destinationGroupId: 'ag-target' }),
      expect.objectContaining({ direction: 'sent', sourceGroupId: 'ag-target', destinationGroupId: 'ag-source' }),
    ]);
  });

  it('does not attach a historical A2A tag to an unrelated tool step', () => {
    const tags = indexA2aRunTags([row({})]).get('ag-source:sess-source')!;

    expect(nearestA2aSentTag(tags, Date.parse('2026-09-03T07:38:06.666Z'))).toBeNull();
    expect(nearestA2aSentTag(tags, Date.parse('2026-08-07T07:30:01.000Z'))).toEqual(
      expect.objectContaining({ direction: 'sent', destinationGroupId: 'ag-target' }),
    );
  });
});
