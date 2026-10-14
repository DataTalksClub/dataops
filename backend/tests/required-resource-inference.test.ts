import { describe, it } from 'node:test';
import assert from 'node:assert';

import { inferRequires } from '../scripts/required-resource-inference';

describe('required-resource inference', () => {
  it('reads the item text, not the checklist tag', () => {
    assert.deepStrictEqual(inferRequires('[YouTube video editing] Update the cover of the YouTube video'), ['youtube']);
    assert.deepStrictEqual(inferRequires('[Podcast page] Moving Podcast Audio in Dropbox'), ['dropbox']);
    assert.deepStrictEqual(inferRequires('Create events on Luma'), ['luma']);
    assert.deepStrictEqual(inferRequires('Invite people to Slack from Airtable'), ['slack', 'airtable']);
  });

  it('reads website-repo links as the website and only sending as email', () => {
    assert.deepStrictEqual(
      inferRequires('Add the event to the webpage ([site](https://github.com/DataTalksClub/datatalksclub.github.io/blob/x))'),
      ['website'],
    );
    assert.deepStrictEqual(inferRequires('Email the sponsor with the document'), ['gmail']);
    assert.deepStrictEqual(inferRequires("Obtain speaker's email"), []);
  });

  it('uses the instruction document area but not its slug', () => {
    assert.deepStrictEqual(inferRequires('Fill in the form', 'sop.newsletter.mailchimp.filling-the-youtube-block'), ['mailchimp']);
  });
});
