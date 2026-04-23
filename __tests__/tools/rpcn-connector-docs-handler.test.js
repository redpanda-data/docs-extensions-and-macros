'use strict';

const { capToTwoSentences } = require('../../tools/redpanda-connect/rpcn-connector-docs-handler');

describe('capToTwoSentences', () => {
  it('keeps sentence boundaries when a URL ends a sentence', () => {
    const input = 'See https://a.com/x. Second sentence. Third sentence.';
    const result = capToTwoSentences(input);

    expect(result).toBe('See https://a.com/x. Second sentence.');
  });
});
