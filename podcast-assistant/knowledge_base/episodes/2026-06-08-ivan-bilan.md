---
id: 2026-06-08-ivan-bilan
status: current
date: 2026-06-08
date_raw: 2026-06-08
guest_name: Ivan Bilan
topic: AI Adoption in Enterprise Beyond Writing Code
source_quality: complete
source_path: podcast_examples/Podcast/2026-06-08 - Ivan Bilan - AI Adoption in Enterprise Beyond Writing Code.docx
themes: ["career_transition", "human_centered_ai", "mlops_production", "education_community", "ai_engineering", "data_platforms", "domain_applications", "applied_ml"]
question_categories: ["story_moments", "practical_advice", "topic_selection", "resources", "background", "current_focus", "reflection"]
---

# Ivan Bilan - AI Adoption in Enterprise Beyond Writing Code

## Bio

Ivan Bilan is a Senior Engineering Manager at Personio, leading multiple teams in the Identity and Access Management (IAM) domain. Previously, he served as a Data Science & Engineering Manager at TrustYou, where he led NLP and infrastructure groups to optimize massive ETL and ML pipelines. With an MS in Computational Linguistics from LMU Munich and a background at CDTM, Ivan bridges the gap between deep technical NLP research and senior leadership in high-throughput enterprise environments. Speech

## Links

- github: https://github.com/ivan-bilan
- linkedin: https://www.linkedin.com/in/ivan-bilan/
- twitter: https://x.com/demiourgosua
- website: my https://github.com/ivan-bilan

## Themes

career_transition, human_centered_ai, mlops_production, education_community, ai_engineering, data_platforms, domain_applications, applied_ml

## Extracted Questions

- How would you like us to introduce you?
- What are you currently focused on—projects or themes you’d enjoy discussing?
- Which topics are you most keen to cover?
- Are there any topics you’d rather skip or avoid discussing publicly?
- What vivid fact, problem, or provocative question will hook listeners?
- What quick stat or story first made you feel this topic matters?
- What key insight or skill will listeners gain?
- Who needs this advice most right now?
- Who wastes time or money if they ignore this?
- Is there a beginner group that keeps asking you about this?
- What 3-5 milestones or ideas should we cover, in order?
- What’s your role, and what single metric or result links you to this topic?
- How does your current job shape your viewpoint here?
- What small action, resource, or reflection would you recommend next?
- Where does this story begin for you?
- Who or what first pulled you toward the topic?
- Which events, successes, or stumbles taught you the most?
- Is there a theme that keeps recurring in your work or study?
- Who might recognize their own journey in yours?
- What 3-5 main stops, projects, or challenges mark the path—listed in order?
- What’s your current role, and what single experience ties you to this theme?
- What fact links present-you to this topic?
- Do you think AI-generated code changes the cost of code review?
- How should engineering managers decide where AI can speed up a team and where it may create hidden work?
- What would you measure to understand whether AI is actually improving engineering work: delivery speed, quality, incidents, developer experience, cost, customer outcomes, or something else?
- Does AI change what junior engineers should learn first?
- What internal setup makes AI coding tools or agents more useful in real teams?
- Are there any books or other resources that you can recommend to the listeners?

## Sections

### Guest Tab

These notes help us draft focused questions and an event description.

### General Questions

How would you like us to introduce you?

What are you currently focused on—projects or themes you’d enjoy discussing?

Which topics are you most keen to cover?

Are there any topics you’d rather skip or avoid discussing publicly?

### Links

LinkedIn: https://www.linkedin.com/in/ivan-bilan/

Twitter: https://x.com/demiourgosua

Github: https://github.com/ivan-bilan

Website: my https://github.com/ivan-bilan

### Detailed Questions

Below are two optional templates you can use when submitting the details for your episode to us.

They’re only guides; feel free to fill in as much or as little as you like, add extra notes, or blend sections from both tables.

If you do include numbers or business outcomes, great; if not, that’s fine too. We’ll craft the final description from whatever you provide.

How to use these templates

Choose one template or mix rows from both.

Write in plain text. No formatting needed unless you’d like to spend time on this.

More details are welcome. Share anecdotes, links, or context you think will help.

Hopefully, this process will also help you to prepare for the podcast.

### Template Practical

What vivid fact, problem, or provocative question will hook listeners?

What quick stat or story first made you feel this topic matters?

If someone had 10 seconds, which pain point would make them keep listening?

What key insight or skill will listeners gain?

Who needs this advice most right now?

Who wastes time or money if they ignore this?

Is there a beginner group that keeps asking you about this?

What 3-5 milestones or ideas should we cover, in order?

What’s your role, and what single metric or result links you to this topic?

How does your current job shape your viewpoint here?

If listeners have 15 minutes, what tiny first step should they take?

What small action, resource, or reflection would you recommend next?

Notes on discussion for the episode:

Ivan:

topic proposal: adoption of AI in enterprise and the related consequences

Sub-topics:

Enterprise decision:

Pay for a license of ready made tools - Claud, Cursor etc

vs. use open source models and spend more time building infra around them, i.e. on top of https://github.com/vllm-project/vllm , https://ollama.com, https://github.com/ggml-org/llama.cpp

If you pay for i.e. Claud:

Spend time on context engineering, learning tools (marketplace plugins, agent teams etc.)

Moving to Context Engineering to ensure better output quality:

I.e. your repo docs need to live next to the code

Go extra mile and give access to team chat, docs, meeting notes etc.

If you go open source:

Choose either fine-tuning open source models

Models develop so fast now that your fine tuning needs to happen often

Or RAG

You need a RAG framework (Llamaindex, LangChain, Haystack, Dify, RAGFlow, AnythingLLM etc)

And a vector database (Qdrant, pgvector, Pinecone, Weavite, Milvus, Chroma etc.)

Orchestration issues are on you (KV cache, pipelines, hosting etc.)

Mixing of both, i.e. with AWS Bedrock

Impact of broader AI adoption on perception of software engineering:

Everyone now found out that coding is not just coding - you need to architect, define requirements, think about tech debt, observability and testing, rollout, maintenance

So AI solved the coding part to an extent but everything else still needs to be done, this is the reason why engineers are still needed

Many companies encourage all roles to code and contribute to production but don’t do the upfront investment into the related release and monitoring automation, and forget that reviewing the code will cost other engineers more time

Developers need time to experiment with the setups to be more efficient

Broader industry impact

Many stopped hiring junior engineers, this is a problem that will only hit us later on as lack of replacement will be a problem

No more training data produced, we stopped asking questions online, so AI can’t learn from new questions - model collapse as a concept and what we can do about it

AI is writing code only it can understand

Now when we write a project, we can tweak and fix it for the most part ourselves

When AI writes a project, we usually don’t understand much or need a lot of time to understand the code, so it’s then easier to ask AI again to rewrite everything again

Gets even more complex with projects like https://veralang.dev/

Shift Right: AI creates more work - more code to review, more output to review

If non-engineers commit code - even more time needed for review

For non-engineering work - work slop means the output is not as good as if an expert did it and requires more more time to review and i.e. verify sources

Orchestration tax

You have to put everything AI gives you together, proof it, fix it, redo etc. Often this takes as much time as if you’d have done the work yourself

Tokenmaxxing vs. valuemaxxing

Instead of using as many tokens as possible (https://www.businessinsider.com/jensen-huang-500k-engineers-250k-ai-tokens-nvidia-compute-2026-3) maximise value and outcomes created

AI security

Necessary guardrails:

PII filtering

Topic blocking

Tone control

Many examples of this backfiring in real world conversations

Output constraints

Ideas:

AI security tools https://www.anthropic.com/glasswing

Broader repercussions: https://futurism.com/artificial-intelligence/anthropic-claude-mythos-escaped-sandbox

https://cybernews.com/ai-news/ai-models-scheme-protect-other-models/

Impact of AI on recent leaks and incidents, i.e. claude code leak, axios etc.

Crazy hacks like https://neuraltrust.ai/blog/grok-morse-code

Stance from security experts: AI can do discovery of issues where there is either no incentive for real world experts or it’s actually not encouraged

Impact of AI on mental health of engineers

Concept of token anxiety https://writing.nikunjk.com/p/token-anxiety; AI psychosis as a new term

AI in some companies became an objective and not a tool

Moving to Context Engineering to ensure better output quality

Great success of AI integration: data analytics and data visualisation tools like Snowflake and Hex have integrated AI agents you can use to speed up data analysis and visualisation

Broader societal impact

Dead internet theory, tools like https://github.com/jamiepine/voicebox or imagegen are getting indistinguishable from real life footage

Internal setups and tweaks to make agents more useful

OpenClaw and other alternatives

Setups like https://github.com/russelleNVy/three-man-team

Optimising token use, i.e. with https://github.com/cancerit/CaVEMan

Effects of claude.md and agents.md https://arxiv.org/abs/2602.11988

Other tweaks combining models https://claude.com/blog/the-advisor-strategy

### Template Personal Story

Give a one-sentence snapshot of the moment that set this journey in motion.

Where does this story begin for you?

Who or what first pulled you toward the topic?

Which events, successes, or stumbles taught you the most?

Is there a theme that keeps recurring in your work or study?

Who might recognize their own journey in yours?

Whose path resembles your early struggles?

What 3-5 main stops, projects, or challenges mark the path—listed in order?

Was there a detour that almost changed your direction?

What’s your current role, and what single experience ties you to this theme?

What fact links present-you to this topic?

If listeners remember one idea next week, what should it be?

We’ll handle the editing and formatting from there. Thanks for contributing to the community!

### Team Tab

AI Adoption in Enterprise Beyond Writing Code

In this episode, we speak with Ivan Bilan, Senior Engineering Manager at Personio, about the transition of AI adoption from experimental phases to routine engineering tasks.

AI can assist with implementation, but software engineering teams still need to handle several critical responsibilities: defining requirements, designing architecture, managing technical debt, testing systems, monitoring production, reviewing changes, planning rollouts, and maintaining their outputs.

We’ll discuss:

How engineering managers can approach AI adoption in enterprise settings.

Where AI can expedite team processes and where it may introduce hidden challenges.

Why companies must be cautious about encouraging everyone to contribute code without investing in processes for releases, review capabilities, observability, and maintenance.

We also explore the wider implications of AI adoption within the software industry, including reduced junior hiring opportunities, evolving expectations for engineers, risks associated with AI-generated systems that may be difficult for humans to comprehend, security concerns, and the shift from “using more tokens” to creating greater value.

### Bio

Ivan Bilan is a Senior Engineering Manager at Personio, leading multiple teams in the Identity and Access Management (IAM) domain. Previously, he served as a Data Science & Engineering Manager at TrustYou, where he led NLP and infrastructure groups to optimize massive ETL and ML pipelines. With an MS in Computational Linguistics from LMU Munich and a background at CDTM, Ivan bridges the gap between deep technical NLP research and senior leadership in high-throughput enterprise environments.

### Speech

Today, we’re discussing AI adoption in enterprise engineering teams. We’ll look at how AI changes perceptions of software engineering, common pitfalls in its adoption, and how to move from just using AI to creating value.

Our guest is Ivan Bilan, Senior Engineering Manager at Personio. He leads teams in Identity and Access Management and previously optimized ETL and ML pipelines at TrustYou. With a master’s in Computational Linguistics from LMU Munich, Ivan connects deep technical research with leadership in fast-paced environments.

Welcome, Ivan!

Before we go into our main topic of X, let’s start with your background. Can you tell us about your career journey so far? (not too long please =))

You’ve worked in NLP and data science before, and now you manage engineering teams in IAM. From your perspective, how has the current AI wave changed the way companies think about software engineering?

If AI can help with implementation, which parts of engineering still require strong human judgment?

In enterprise environments, what usually happens after someone generates code with AI? What are the next steps before it can become part of a real product?

Do you think AI-generated code changes the cost of code review? Can it make reviewing harder rather than easier?

How should engineering managers decide where AI can speed up a team and where it may create hidden work?

There is a lot of pressure to use more AI, more agents, and more tokens. How can teams avoid optimizing for AI usage itself and focus instead on business or engineering value?

What would you measure to understand whether AI is actually improving engineering work: delivery speed, quality, incidents, developer experience, cost, customer outcomes, or something else?

There is a trend of companies hiring fewer junior engineers or expecting juniors to become productive faster with AI. What long-term risks could this create for engineering teams?

Does AI change what junior engineers should learn first? For example, should they focus more on debugging, architecture, testing, or understanding systems?

What internal setup makes AI coding tools or agents more useful in real teams? For example, documentation, coding standards, repo structure, architecture notes, or files like claude.md and agents.md.

Are there any books or other resources that you can recommend to the listeners?
