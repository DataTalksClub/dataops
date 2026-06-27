---
id: 2026-06-15-aleksandr-kim
status: current
date: 2026-06-15
date_raw: 2026-06-15
guest_name: Aleksandr Kim
topic: How to Build AI That Actually Ships in Production
source_quality: partial
source_path: podcast_examples/Podcast/2026-06-15 - Aleksandr Kim - How to Build AI That Actually Ships in Production.docx
themes: ["ai_engineering", "mlops_production", "career_transition", "applied_ml", "human_centered_ai", "education_community", "domain_applications", "data_platforms"]
question_categories: ["topic_selection", "story_moments", "practical_advice", "resources", "background", "current_focus"]
---

# Aleksandr Kim - How to Build AI That Actually Ships in Production

## Bio

Senior Data Scientist at Intuit, based in London — doing what most people outside the company would now call AI engineering: building AI-powered features in production at scale. About 9 years across banking (Raiffeisen), cybersecurity (Kaspersky), retail (X5 Retail Group), and fintech (Intuit), with experience on both sides of the IC–management line: I led two data science teams at X5 Retail Group before moving back to IC at Intuit, and I founded and run Intuit's 70+ member Data Science Guild. Inventor on 15+ ML/AI patents. Links:

## Links

- github: no interesting public repos
- linkedin: https://www.linkedin.com/in/aleksandrkim/
- website: https://alexkimds.github.io/

## Themes

ai_engineering, mlops_production, career_transition, applied_ml, human_centered_ai, education_community, domain_applications, data_platforms

## Extracted Questions

- How would you like us to introduce you?
- What are you currently focused on—projects or themes you’d enjoy discussing?
- Which topics are you most keen to cover?
- Are there any topics you’d rather skip or avoid discussing publicly?
- What vivid fact, problem, or provocative question will hook listeners?
- Which events, successes, or stumbles taught you the most?
- Is there a theme that keeps recurring in your work or study?
- Who might recognize their own journey in yours?
- What 3–5 main stops, projects, or challenges mark the path?
- What key insight or skill will listeners gain?
- Tell us about the agentic system you built at Intuit. What does it do, and how did it end up saving leadership over 30 hours a week?
- Let's talk cost. You cut inference spend by about a third using cheap models for the easy cases and saving the expensive LLM judge for the hard ones. How does that work in practice?
- Are there any books or other resources that you can recommend to the listeners?

## Sections

### Guest Tab

These notes help us draft focused questions and an event description.

### General Questions

How would you like us to introduce you?

Senior Data Scientist at Intuit, based in London — doing what most people outside the company would now call AI engineering: building AI-powered features in production at scale. About 9 years across banking (Raiffeisen), cybersecurity (Kaspersky), retail (X5 Retail Group), and fintech (Intuit), with experience on both sides of the IC–management line: I led two data science teams at X5 Retail Group before moving back to IC at Intuit, and I founded and run Intuit's 70+ member Data Science Guild. Inventor on 15+ ML/AI patents.

What are you currently focused on—projects or themes you’d enjoy discussing?

Agentic systems for executive decision-making. I architected an LLM-based agentic system at Intuit that aggregates data, automatically generates reports, and delivers them directly to decision-makers in Slack. It saves 30+ hours/week at the leadership level — but the more interesting story is how it started as an AI chatbot and pivoted to automation after customer interviews showed me the chatbot was nice-to-have, not the real pain.

Grounding and trust for AI outputs. I'm currently building a knowledge base with human-in-the-loop verification used to verify / ground AI outputs and increase trust in them. Every enterprise is wrestling with the same two problems right now: speeding up delivery for non-experts AND getting people to actually trust AI tools. They're the same problem.

Which topics are you most keen to cover?

Career arc: Data scientist → ML engineer → Data scientist → AI engineer. The labels change often, but the actual work has barely changed. My current title at Intuit is Senior Data Scientist; outside Intuit the same work is called AI Engineering. I'd love to tell that story honestly

"The model is rarely the win." Three stories from different parts of my career where business reframing mattered far more than the model: a fine-tuned BERT for customer customer-support project at Kaspersky (2019–2020) where actual win was reframing 200 categories down to the 20–30 that were actually actionable and linking ML metrics to business outcomes; the agentic insights system at Intuit pivoting from chatbot to automation; and a cost-efficient ML-based filter for LLM-as-judge evaluation that cut inference spend by about 33%.

Knowing when to abandon. Most people publish their wins. I'd love to talk about a transaction-extraction project I worked on at Intuit that I had to abandon — and then watched a more senior team try it again with better infrastructure and abandon it for the same reason. Some problems don't move. Recognizing that earlier is one of the most senior moves you can make.

The big-company career path. Most "how to become an AI engineer" stories are startup or side-project flavored. I'd love to share the other path: navigating changes, manager conversations, and lateral moves inside a big corp. I led two data science teams at X5 Retail Group before circumstances took me back to IC at Intuit, where I later founded the Data Science Guild — because day one I'd told my manager I wanted to return to management eventually.

Are there any topics you’d rather skip or avoid discussing publicly?

I'd rather keep references to the wars in Russia and Israel descriptive rather than political — I left Russia in 2022 like many tech workers did, and we left Israel in 2024 because of the regional situation. Beyond that I'd rather not go into either.

Recent layoffs at Intuit (May 20, 2026)

### Links

LinkedIn: https://www.linkedin.com/in/aleksandrkim/

Twitter: -

Github: no interesting public repos

Website: https://alexkimds.github.io/

LinkedIn: TODO

Twitter: TODO

Github: TODO

Website: TODO

### Detailed Questions

Mixed Template Answers (Template 2 spine + selected Template 1 anchors)

Give a one-sentence snapshot of the moment that set this journey in motion.During my bachelor's at MIPT, I took a machine learning course that wasn't part of my major. I went out of curiosity. The idea that you could use data to find repeatable, predictable patterns — and in some sense predict the future — felt like magic. That was the moment.

What vivid fact, problem, or provocative question will hook listeners?AI didn't shrink the gap between PoC and product. It just made the PoCs cheaper. I've watched seasoned DS professionals — people who spent years on the same problem — get seduced by a slick AI demo that looked great from the dev side and was a disaster from the customer side. The unglamorous work between demo and deployment is still there.

Which events, successes, or stumbles taught you the most?Three projects, in order of how much they shaped me:

Kaspersky, 2019–2020. I fine-tuned BERT for customer-support automation. Initially I was given a 200-category text classification task, but only 20–30 of those categories were actionable for the business. The win wasn't the BERT model — fine-tuning a transformer was hard in 2019 and felt like a real achievement at the time, but that wasn't the value. The value was reframing the problem around what the business actually cared about, and translating ML metrics like precision and recall into business metrics like First Contact Resolution and automation rate. Once stakeholders saw the value framed that way, we iterated fast and cut support costs by about 20%. That lesson — the model is rarely the win — is one I've recycled in every project since.

Intuit, early 2023, transaction extraction from 20,000+ financial data sources. We initially tried using LLMs to write extraction scripts per provider. The infrastructure wasn't ready, the LLMs at that moment couldn't write executable code reliably on the first try, and we abandoned that approach. We pivoted to a divide-and-conquer model — a small NER-like system that navigated HTML pages and parsed transactional columns. It worked well. But the project stalled because the customer couldn't set up data access in time — PII obfuscation took longer than the model itself. Two years later, after I moved to London, I heard a more senior team picked the project up again with better infrastructure and current-generation LLMs. It got stuck at the same stage. First I thought I hadn't pushed hard enough the first time. When it failed under better-resourced people, I realised — some problems just don't move. The most productive thing you can do is recognize that earlier and move to the next doable thing.

The agentic insights system at Intuit. Started as a POC: an AI chatbot with access to internal databases. In parallel I led customer interviews with marketing, sales, and other internal teams. The interviews made it clear that the chatbot was nice-to-have. The real pain was manual report assembly — leadership was making decisions on Tuesday on last week's data, because the analysts were manually writing their summaries and commentary. We pivoted to automated reports plus AI-generated commentary (summaries) delivered straight into Slack. We didn't just save 30+ hours of executive time per week. We collapsed the decision-latency gap. If I could plant one lesson in every junior LLM-app builder's head, it would be: run customer interviews before you build the chatbot.

Is there a theme that keeps recurring in your work or study?

The model is rarely the win. The leverage is upstream: in choosing the right problem, talking to customers, reframing metrics around what the business actually cares about.

Know when to abandon. Some projects don't move regardless of infrastructure or team. The most senior thing you can do is recognize that early and move to the next doable thing.

Who might recognize their own journey in yours?

People doing AI/ML work inside large companies, especially those whose classical ML projects have been disrupted by LLMs and who are trying to figure out where their value sits now.

People who've taken a sideways step in their career — back to IC after managing, back to senior/middle after tech lead / staff — to get into a new country, a new company, or a new domain, and are wondering whether they'll ever climb back.

And anyone currently grinding on a project that won't move, blaming themselves for it.

What 3–5 main stops, projects, or challenges mark the path?

Kaspersky, 2019–2021. Fine-tuned BERT for customer-support automation; 20% cost reduction. First time deploying a transformer into production felt like a real engineering achievement at the time. The bigger lesson was that the model wasn't what made the project ship.

X5 Retail Group, 2021–2022. My first management role. Led two data science teams on promo optimization and pricing, forecasting 100,000+ time series daily across more than 20,000 stores. Hired one team from scratch and also supported hiring for DS, DE, and DQ specialists for other teams. I moved back to IC at Intuit during a relocation, and the management muscle has stayed active through the Data Science Guild.

The 2022 move to Israel and Intuit. I was already looking to leave. When the X5 product I led was closed, external forces simplified a decision I'd been struggling with — I wanted to leave but was attached to the career I'd built. I applied to management roles from outside the country, got zero responses, and took an IC role at Intuit to get my foot in the door. I was transparent with my manager and told I wanted to return to management eventually. The Guild opportunity came about some time after I'd told my manager about my ambitions — he remembered, and when his manager floated reviving the data community, I was ready.

London, end of 2024 — becoming the AI person of contact. After moving to London, several of my classical ML projects were deprioritized, and the new projects I was assigned were much smaller and less impactful. Emotionally this was the toughest stretch of my career so far. But that same period turned into a transformation. I started giving seminars on LLM architectures and coding agents for analysts and developers across the org, and gradually became the AI person of contact for people learning to work with these tools. A Canadian data scientist later told me their AI setup was inspired by my seminars. That kind of feedback meant a lot — and it pointed at something I'm still thinking about. Impact in AI work is often real but hard to feel. A project that saves 30+ hours a week at the executives level matters in money terms (imagine salary of International business leaders and impact of their decisions on the business), but it doesn't land emotionally the way one colleague telling you their work shifted because of yours does. That stretch is also when my own role transitioned from classical ML and data science into what's now called AI engineering.

What key insight or skill will listeners gain?

For anyone working on AI features in a real company:

Run customer interviews before you build a complex AI solution. Often chatbots are not the answer. Automation usually is.

Translate ML metrics into business metrics on day one. ML metrics are an input. They are not deliverables.

Use cheap models for simple tasks. Most cases in any classifier are easy. Save the LLM judge for the hard cases.

For anyone navigating a career inside a big company:

Tell your manager what you want — clearly, explicitly, more than once. You can't control whether they remember, whether the opportunity comes up, or whether it comes up in time. You can only control whether your ambitions are legible. It doesn't always work. But it never works if you don't try.

Know when to abandon. Pushing harder is not always the answer.

If listeners remember one idea next week, what should it be?The model is rarely the win.Looking back at the projects that mattered most to me — fine-tuning BERT for customer support at Kaspersky in 2019, the agentic insights pivot at Intuit, the LLM-as-judge cost optimization — the model was always necessary and almost never sufficient. What shipped the result was the business reframing upstream of it. That's worth holding onto in the LLM era especially, when the demos look so impressive it's easy to forget where the real work lives.

Optional extras the team is welcome to use or ignore:

An early-career detail that didn't fit the main arc: At Raiffeisen Bank in 2018–2019, our team spent a couple of weeks at Yandex and Mail.ru — we brought our bank data onto their infrastructure to see if richer features would translate to enough business impact to pay for the partnership. That's where I first saw an interesting data engineering technique — embedding-centroid customer profiling: interests as vectors, distances from customer-vectors to the interests as features. I tried to replicate it later at a smaller scale and it didn't work, because at that dimensionality the data volume just wasn't there. A small early lesson in not copy-pasting techniques across scale.

A demystification of patents: a patent is usually a new combination of existing ideas applied to a domain where they weren't combined before. Example from my own list: combining embeddings with n-grams to disambiguate short bank-transaction descriptions, using the financial domain as the anchor. Public on USPTO.

A humanizing anecdote outside work: I picked up skimboarding in Israel after friends saw me watching videos and gifted me a board. When I moved to London I tried to organize a legal spot in a park — contacted the council, the municipal events team, and several insurance companies (most don't insure individual-led events). I pivoted to a smaller version: building a 25-meter tarp pool 5cm deep with 1–2 tons of water. I was tired before I even started riding. I abandoned the project and now skimboard a few times a year at the seaside. The same principle as my professional projects, at miniature scale.

### Rough Plan

Overall duration – up to 1 hour

Intro (5 minutes)

Prepared questions from me about the topic (30-40 minutes)

Questions from the audience (the remaining time)

### Event Description

Title: How to Build AI That Actually Ships in Production

Aleksandr Kim has spent nearly a decade doing what the industry now calls AI engineering, long before the title existed. As a Senior Data Scientist at Intuit in London, he builds AI-powered features in production at scale, and his career traces the full arc from data scientist to ML engineer and now AI engineer, where, as he puts it, the labels keep changing but the actual work barely has.

In this conversation, Aleksandr unpacks one hard-won lesson from the front lines of enterprise AI: the model is rarely the win. He walks through the agentic system he architected at Intuit, one that aggregates data, auto-generates reports, and delivers them straight to leadership in Slack, saving over 30 hours of executive time a week, and explains why it only worked after he killed the original chatbot idea.

What we get into:

Why AI didn't shrink the gap between proof-of-concept and product. It just made the PoCs cheaper, and the unglamorous work between demo and deployment is still very much there.

The agentic system that pivoted from chatbot to automation, and why customer interviews, not better modeling, were what made it ship.

Translating ML metrics into business outcomes, turning precision and recall into things like First Contact Resolution and automation rate, on day one.

Cost-efficient AI at scale, using cheap models for the easy cases and saving the LLM judge for the hard ones, cutting inference spend by about a third.

Knowing when to abandon, the underrated senior skill of recognizing a problem that simply won't move, no matter the infrastructure or team.

If you're an engineer or data scientist trying to figure out where your value sits in the LLM era, especially inside a large company, this one's for you.

### Bio

Senior Data Scientist at Intuit, based in London — doing what most people outside the company would now call AI engineering: building AI-powered features in production at scale. About 9 years across banking (Raiffeisen), cybersecurity (Kaspersky), retail (X5 Retail Group), and fintech (Intuit), with experience on both sides of the IC–management line: I led two data science teams at X5 Retail Group before moving back to IC at Intuit, and I founded and run Intuit's 70+ member Data Science Guild. Inventor on 15+ ML/AI patents.

### Speech

This week we're talking about what it actually takes to build AI in production, the unglamorous work that happens after the impressive demo, and how to tell when a project is worth pushing on versus walking away from.

We have a special guest today, Aleksandr Kim. Aleksandr is a Senior Data Scientist at Intuit, based in London, doing what most people outside the company would now call AI engineering: building AI-powered features in production at scale. He's spent about nine years across banking, cybersecurity, retail, and fintech, at Raiffeisen, Kaspersky, X5 Retail Group, and now Intuit, on both sides of the IC and management line. He led two data science teams at X5 before moving back to IC at Intuit, where he founded and runs the company's 70-plus-member Data Science Guild. He's also an inventor on more than 15 ML and AI patents.

Welcome, Aleksandr!

Top 10 questions

Your title is Senior Data Scientist, but the work is what most people now call AI engineering. Walk us through that arc from data scientist to ML engineer to AI engineer. What actually changed, and what didn't?

You say "the model is rarely the win." What do you mean by that, and when did that lesson first land for you?

Tell us about the agentic system you built at Intuit. What does it do, and how did it end up saving leadership over 30 hours a week?

That system started as a chatbot and you killed that idea. What did the customer interviews tell you that the demo couldn't?

You've said AI didn't shrink the gap between proof-of-concept and product, it just made the PoCs cheaper. Why is the work between demo and deployment still so hard?

You have a habit of translating ML metrics into business metrics on day one. Why does that matter so much, and what goes wrong when teams skip it?

Let's talk cost. You cut inference spend by about a third using cheap models for the easy cases and saving the expensive LLM judge for the hard ones. How does that work in practice?

One of your themes is knowing when to abandon a project. Tell us about one you walked away from, and how you knew it was the right call.

You watched a more senior team later pick up a project you'd abandoned and get stuck at the same point. What did that teach you about which problems simply don't move?

For an engineer or data scientist trying to figure out where their value sits in the LLM era, especially inside a large company, what's the one thing you'd tell them?

Are there any books or other resources that you can recommend to the listeners?
