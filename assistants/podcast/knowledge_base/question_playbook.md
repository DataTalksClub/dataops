# Podcast Question Playbook

This playbook captures the DataTalks.Club podcast question style from the past
episode archive. Use it when preparing questions for a new guest.

The goal is not to generate generic interview questions. The goal is to turn a
guest's bio, topic, projects, claims, and constraints into a focused interview
arc that sounds like our past episodes.

## Core Principle

Start from evidence, not from the topic label.

Weak input:

> Guest works on AI agents.

Weak output:

> What are AI agents? Why are they important? What is the future of agents?

Better input:

> Guest built an internal agentic reporting system that replaced a chatbot idea,
> saved leadership time, and exposed trust/grounding problems.

Better output:

> That system started as a chatbot and you killed that idea. What did the
> customer interviews tell you that the demo could not?

## The House Style

Questions should usually be:

- Grounded in a specific fact from the guest's bio, project, or claim.
- Conversational and direct.
- Curious about trade-offs, not just success stories.
- Concrete enough that the guest can answer with a story.
- Useful to listeners who want to learn or apply the lesson.
- Sequenced so the guest warms up before technical or reflective questions.

Avoid:

- Generic encyclopedia questions.
- Questions that could be asked to any guest.
- Multiple unrelated questions in one sentence.
- Questions that only invite marketing answers.
- Overly broad future questions before the episode has earned them.
- Questions that repeat the guest's bio without adding a point of tension.

## What Actual Asked Questions Add

The prep documents show the planned arc. The actual podcast transcripts show the
live voice. Use both.

Actual asked questions are often less polished than prep questions, but more alive:

- They include a short setup before the question.
- They use the guest's previous answer as context.
- They ask for clarification when a term is vague.
- They check whether Alexey understood correctly.
- They use concrete examples from Alexey's own understanding.
- They sometimes go off script when the guest says something interesting.
- They are comfortable being simple: "What is that?", "Is it like X?", "Right?"

This is important. A good prepared document should include strong planned
questions, but it should also create room for these reactive follow-ups.

Actual-question patterns from transcripts:

### Clarify A Term

Use when the guest uses a term that listeners may not know.

Patterns:

- What exactly is `<term>`?
- Is `<term>` like `<familiar example>`?
- Can you clarify what `<concept>` means?

Examples from actual questions:

- What exactly is edge computing? Is it similar to devices like this one?
- Can you explain what Apache Iceberg is?
- You mentioned databases have four layers: storage, compute, access, and metadata. Can you clarify what a catalog is?

### Confirm Understanding

Use when the guest explains a mechanism and you want to make it concrete.

Patterns:

- So it is basically `<your interpretation>`, right?
- If I understand correctly, `<summary>`. Is that how it works?
- So the problem is `<specific bottleneck>`?

Examples from actual questions:

- So it’s a bunch of Parquet files on S3 with metadata?
- So DuckDB allows us to process data locally and save results back to storage?
- So, the problem with Kubernetes is that it’s not optimized for AI use cases?

### Compare Two Options

Use when listeners need a decision frame.

Patterns:

- How does `<A>` compare to `<B>`?
- When should someone use `<A>` instead of `<B>`?
- If we already have `<existing tool>`, why do we need `<new tool>`?

Examples from actual questions:

- Okay, but if we already have Kubernetes, why do we need another universal tool?
- What about alternatives like SQLMesh?
- What about workflow orchestration? What should we use in 2025?

### Bring In A Concrete Example

Use when the topic risks becoming abstract.

Patterns:

- For example, if `<realistic situation>`, what happens?
- Suppose `<listener scenario>`. What should they do?
- Is this like `<concrete tool/company/device>`?

Examples from actual questions:

- If I have a team of ten people and just a few machines, coordinating GPU usage for training models becomes a hassle. That’s another form of on-prem, right?
- We have an audience question: How do you transition into freelancing with a three-month notice period, which is common in Germany?
- Is that like organizing data storage, deciding whether to use S3, MySQL, Hadoop, and so on?

### Challenge The Premise Gently

Use when the guest makes a broad claim or the common narrative may be wrong.

Patterns:

- Is that always true?
- But does this also apply to smaller companies?
- If `<old solution>` exists, what is missing?

Examples from actual questions:

- Larger companies like Meta, Google, and OpenAI have different challenges from smaller ones, right?
- As a software engineer, should I stay away from Kubernetes, or is it still a good tool to have in my toolkit?
- Will data engineering be automated by AI?

### Go Off Script Productively

Use when the guest says something unexpectedly interesting.

Patterns:

- I want to apologize for going off script, but `<follow-up>`.
- You mentioned `<detail>`. Can we pause there?
- That sounds important. How did that happen?

Actual style note:

These questions can be longer than planned questions because they carry context.
That is acceptable when the setup helps listeners understand the follow-up.

## Question Arc

Most strong documents follow this order.

### 1. Background Opener

Purpose: let listeners place the guest.

Use when:

- The guest has a non-linear path.
- The guest changed domains.
- The guest's credibility matters for the topic.

Patterns:

- Can you tell us about your background and how you got into `<field>`?
- You moved from `<old domain>` to `<new domain>`. What made that transition happen?
- Which part of your path matters most for understanding today's topic?

House-style examples:

- How do you learn machine learning while studying medicine and turn it into a full-time career?
- How has your background influenced your approach to fairness in AI?
- Can you summarize your career after Kaggle and how Kaggle helped you?

### 2. Current Focus

Purpose: connect the guest to the topic right now.

Use when:

- The guest's current role is broad.
- The title does not explain what they actually do.
- The guest has several possible topic directions.

Patterns:

- What are you working on today?
- What projects are taking most of your attention right now?
- Your title is `<title>`, but the work sounds closer to `<actual topic>`. What does the work look like in practice?

House-style examples:

- What projects do you work on at JPMorganChase?
- What are typical projects that fellows work on during their fellowship?
- How did your time at CMU and Microsoft working on speech and language modeling shape how you approach today's LLM and agent systems?

### 3. Topic Framing

Purpose: define why this episode exists.

Use when:

- The topic could become too abstract.
- The audience needs a reason to care.
- The guest has a strong opinion or claim.

Patterns:

- What is the misconception people have about `<topic>`?
- Why does `<topic>` matter now?
- Who has this problem most painfully?
- What changed recently that made this topic more urgent?

House-style examples:

- What specific challenges do AI engineers face with current infrastructure solutions?
- What’s a misconception about "intelligent assistants" you often encounter, even among ML professionals?
- What are reasons that AI fails to be adopted by employees in company settings?

### 4. Concrete Story Or Project

Purpose: get out of abstraction.

Use when:

- The guest mentions a project, launch, product, paper, company, dataset, or metric.
- The episode needs a narrative spine.
- The guest has a failure or pivot.

Patterns:

- Tell us about `<project>`. What did it do?
- Where did the project start, and what did it become?
- What surprised you once real users or stakeholders got involved?
- What failed or had to change?

House-style examples:

- Tell us about the agentic system you built at Intuit. What does it do, and how did it end up saving leadership over 30 hours a week?
- Can you tell us about the projects you built, like Willmojis and Horrible Audio?
- Can you share a story where business or product limits shaped the final solution more than the technical side?

### 5. Technical Deep Dive

Purpose: satisfy technical listeners without turning the episode into a lecture.

Use when:

- The guest has implemented something.
- The topic includes architecture, data, models, tooling, or evaluation.
- The audience can learn from practical trade-offs.

Patterns:

- How does `<system>` work at a high level?
- What data or infrastructure made this hard?
- What did you try first, and why did it not work?
- How do you evaluate whether `<system>` works?
- What are the failure modes?

House-style examples:

- How can infrastructure limit or hinder the deployment of AI models?
- How should teams evaluate whether an agent-based system is working as intended before scaling it?
- What does evaluation-driven development look like in day-to-day practice?
- How do you decide what model to train or run?

### 6. Production Reality

Purpose: uncover the real work between demo and production.

Use when:

- The guest talks about shipping, adoption, enterprise, or reliability.
- The topic involves AI systems, data products, or ML in production.

Patterns:

- What broke when this moved beyond the demo?
- What made the project production-ready?
- What did you have to monitor?
- How did cost, latency, privacy, or compliance shape the solution?
- What did you remove or simplify?

House-style examples:

- How can teams balance rapid experimentation with robust monitoring and testing in production AI systems?
- What is the most common mistake you see teams make when they try to scale a prototype?
- How do you handle hallucinations in enterprise GenAI systems?

### 7. Business / Product Impact

Purpose: connect technical work to value.

Use when:

- The guest mentions a metric, business result, stakeholder, user, or customer.
- The project succeeded because of framing, not just modeling.

Patterns:

- Which metric told you this mattered?
- What did stakeholders care about that the model metrics did not capture?
- How did customer interviews change the direction?
- What evaluation metric turned out to be misleading?

House-style examples:

- What’s your role, and what single metric or result links you to this topic?
- Which interview questions or frameworks gave you the clearest signal that a prototype solved a real customer problem?
- What evaluation methods or metrics turned out to be misleading in practice, and what did you replace them with?

### 8. Organizational Reality

Purpose: expose the human and company constraints.

Use when:

- The guest works in a large company.
- Adoption, management, team structure, governance, or compliance matters.
- The story involves handoff between teams.

Patterns:

- How did the organization shape what was possible?
- Where did adoption get stuck?
- What did managers or stakeholders need to see?
- How do you decide the realistic speed of change?

House-style examples:

- How should engineering managers decide where AI can speed up a team and where it may create hidden work?
- When a company comes with a GenAI idea, how do you decide whether it is a good use case for LLMs in the first place?
- How do you determine the maximum speed at which a traditional organization can realistically absorb digital transformation?

### 9. Advice / Learning Path

Purpose: turn the guest's experience into listener value.

Use when:

- The episode is about career, learning, AI engineering, freelancing, or domain transition.
- The guest has a repeatable lesson.

Patterns:

- What should someone do first if they want to follow this path?
- What mistake should beginners avoid?
- Which skill is underrated?
- What would you tell someone currently stuck at `<situation>`?

House-style examples:

- What advice would you give to people who have just finished their studies and would like to start working in ML/AI?
- Do you have any advice for people who want to close gaps in their education around ML and AI?
- Does AI change what junior engineers should learn first?

### 10. Future And Resources

Purpose: close with perspective and useful next steps.

Use when:

- The interview has already covered concrete ground.
- The guest is credible enough to forecast.

Patterns:

- What trend are you watching that others underestimate?
- What do you expect to change in the next 3-5 years?
- Which books, tools, papers, courses, or communities should listeners check?

House-style examples:

- What do you think the AI engineering role will look like in the next 3-5 years?
- What potential trends are you excited about?
- Are there any books or other resources that you can recommend to the listeners?

## How To Derive Questions From Inputs

Use these transformations.

### From Bio

Input signal:

- Role, company, domain, previous roles, career pivots, unusual background.

Turn into:

- Credibility question.
- Transition question.
- "How does your background shape this topic?" question.

Examples:

- Bio says: "Computational linguist working on AI fairness."
- Ask: "How has your linguistics background influenced your approach to fairness in AI?"

- Bio says: "Senior data scientist doing AI engineering work."
- Ask: "Your title is Senior Data Scientist, but the work sounds like AI engineering. What actually changed, and what did not?"

### From Topic

Input signal:

- Topic title or proposed episode angle.

Turn into:

- Misconception question.
- Why-now question.
- Audience pain question.

Examples:

- Topic: "Enterprise AI adoption."
- Ask: "What are reasons that AI fails to be adopted by employees in company settings?"

- Topic: "Reliable AI assistants."
- Ask: "Where do current agent systems most reliably fail?"

### From Project

Input signal:

- Named system, product, dataset, launch, paper, open-source project, startup.

Turn into:

- Story question.
- Architecture question.
- Failure-mode question.
- Metric question.

Examples:

- Project: "Agentic reporting system in Slack."
- Ask: "Tell us about the system. What did it do, and what changed once leaders started using it?"

- Project: "ASR for disordered speech."
- Ask: "What unique challenges arise when adapting ASR for people with speech disorders?"

### From Claim

Input signal:

- Strong phrase like "the model is rarely the win" or "AI makes PoCs cheaper."

Turn into:

- Clarification question.
- Evidence question.
- Counterexample question.

Examples:

- Claim: "The model is rarely the win."
- Ask: "What do you mean by that, and when did that lesson first land for you?"

- Claim: "AI did not shrink the gap between PoC and production."
- Ask: "Why is the work between demo and deployment still so hard?"

### From Metric

Input signal:

- Time saved, cost reduction, accuracy, revenue, users, scale, latency.

Turn into:

- Impact question.
- Trade-off question.
- Measurement question.

Examples:

- Metric: "Saved 30+ hours per week."
- Ask: "Where did those 30 hours disappear from, and how did you know the system was creating real value?"

- Metric: "Cut inference spend by 33%."
- Ask: "How did you decide which cases deserved the expensive model and which could use a cheaper one?"

### From Tension

Input signal:

- Demo vs production, model metric vs business metric, automation vs judgment, speed vs quality, compliance vs innovation.

Turn into:

- Trade-off question.
- Decision question.
- Boundary question.

Examples:

- Tension: "AI speeds up coding but may create hidden review work."
- Ask: "How should engineering managers decide where AI speeds up a team and where it creates hidden work?"

- Tension: "Human-in-the-loop trust."
- Ask: "How can organizations make sure human judgment still guides interpretation and decision-making in AI workflows?"

## Question Generation Recipe

For each new guest, produce questions in this order.

1. Extract facts:
   - guest role
   - current work
   - strongest projects
   - strongest claims
   - metrics
   - domain constraints
   - sensitive topics

2. Pick one episode angle:
   - "This episode is about `<specific audience>` learning `<specific lesson>` from `<guest's concrete experience>`."

3. Retrieve 3-5 similar past episodes from the knowledge base.

4. Search both question banks:
   - `data/podcast_questions.csv` for planned prep questions.
   - `data/actual_podcast_questions.csv` for actual transcript phrasing.

5. Draft 18-25 candidate questions:
   - 3 background/current-focus questions
   - 4 topic-framing questions
   - 5 project/technical questions
   - 3 production/business questions
   - 3 advice/future/resource questions

6. Add 5-8 live follow-up prompts:
   - clarification prompts
   - confirmation prompts
   - comparison prompts
   - concrete-example prompts
   - gentle challenge prompts

7. Cut to 10-14 final planned questions:
   - Keep the questions tied to guest-specific facts.
   - Remove generic questions.
   - Keep one resource question at the end.
   - Avoid asking the same shape twice.

## Quality Checklist

Before finalizing, check:

- Does every question have a reason to be asked to this guest specifically?
- Is there a concrete project or story in the middle of the interview?
- Do we ask about trade-offs, failures, or constraints?
- Do we connect technical details to user/business value?
- Is the listener learning something practical?
- Are sensitive topics either avoided or framed carefully?
- Could this question be answered by a generic blog post? If yes, sharpen it.

## Prompt For The Agent

Use this when asking Codex/Claude through Heru to draft a podcast document:

```text
Read knowledge_base/question_playbook.md, data/podcast_questions.csv, and
data/actual_podcast_questions.csv.

Create a podcast preparation document for this guest using the DataTalks.Club
question style. Do not generate generic podcast questions.

Use the guest material below to:
1. identify the episode angle,
2. classify the topic cluster,
3. find similar past question patterns,
4. derive questions from bio, projects, claims, metrics, and tensions,
5. produce 10-14 final planned questions in a coherent interview arc,
6. add 5-8 likely live follow-ups in Alexey's actual transcript style.

For every final question, include a short note explaining which guest-specific
fact caused that question.
```
