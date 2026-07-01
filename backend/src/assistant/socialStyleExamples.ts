export interface SocialStyleExample {
  accountKey: 'alexey' | 'datatalksclub';
  platform: 'x' | 'linkedin';
  label: string;
  text: string;
}

const STYLE_EXAMPLES: SocialStyleExample[] = [
  {
    accountKey: 'alexey',
    platform: 'x',
    label: 'Personal workshop announcement',
    text: [
      'Personalization in AI agents becomes much more useful when the agent can use what the user already knows.',
      '',
      'In the workshop we will build a small assistant, connect it to real context, and test where personalization helps or gets in the way.',
      '',
      'Register here: <event link>',
    ].join('\n'),
  },
  {
    accountKey: 'alexey',
    platform: 'linkedin',
    label: 'Personal course/resource post',
    text: [
      'A good AI engineering project is not only a model call.',
      '',
      'It needs retrieval, evaluation, failure handling, and a workflow where a human can inspect the result before it reaches users.',
      '',
      'That is the kind of system we practice in the course: small enough to build, realistic enough to expose the engineering tradeoffs.',
      '',
      'More details: <resource link>',
    ].join('\n'),
  },
  {
    accountKey: 'datatalksclub',
    platform: 'x',
    label: 'Community course reminder',
    text: [
      'A new cohort of the ML Zoomcamp starts soon.',
      '',
      'It is a free course for learning ML engineering through practical projects:',
      '',
      '- model training',
      '- evaluation',
      '- deployment',
      '- production workflows',
      '',
      'Join here: <course link>',
    ].join('\n'),
  },
  {
    accountKey: 'datatalksclub',
    platform: 'linkedin',
    label: 'Community workshop announcement',
    text: [
      'Join our next DataTalks.Club workshop.',
      '',
      'We will cover a practical workflow end to end, from the problem setup to the implementation details that matter in production.',
      '',
      'You will learn:',
      '',
      '- what to build first',
      '- how to validate the result',
      '- where common failures appear',
      '- how to continue after the workshop',
      '',
      'Register here: <event link>',
    ].join('\n'),
  },
];

function styleExamplesFor(accountKey: 'alexey' | 'datatalksclub'): SocialStyleExample[] {
  return STYLE_EXAMPLES.filter((example) => example.accountKey === accountKey);
}

export {
  STYLE_EXAMPLES,
  styleExamplesFor,
};
