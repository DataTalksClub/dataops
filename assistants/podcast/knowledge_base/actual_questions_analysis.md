# Actual Podcast Questions Analysis

Source: https://github.com/DataTalksClub/datatalksclub.github.io/tree/main/_podcast
Source commit: `a2dc529740ed1714b8d22069b5327930d0f73283`

Parsed podcast files: 202
Extracted actual Alexey questions: 222

## Category Counts

- general: 124
- technical_deep_dive: 54
- practical_advice: 11
- background: 10
- organizational_reality: 7
- current_focus: 5
- future_outlook: 5
- topic_selection: 2
- resources: 1
- business_impact: 1
- story_moments: 1
- reflection: 1

## Common Question Starters

- how: 22
- so: 21
- i: 15
- do: 15
- you: 14
- what: 14
- is: 8
- the: 5
- and: 5
- okay: 5
- for: 5
- that: 4
- are: 4
- well: 3
- since: 3
- before: 3
- where: 3
- was: 3
- what’s: 3
- as: 2

## Common Transcript Sections

- Coaching Delivery: LinkedIn, Calendly, one-shot sessions, and CV reviews: 5
- Teamwork, Communication & Dual Leaderboards (ML + Technical): 4
- Career Background: JetBrains, DataSpell, and Move into AI: 3
- Cloud-to-On-Prem Realities in the Post-ChatGPT Era: 3
- Training at Scale: GPU Requirements and Distributed Challenges: 3
- Market Trends & Building a Data-Freelancer Job Board: 3
- Job Board Insights: Rates, Top Skills & "Data Management": 3
- AI Tools for Productivity: Claude, ChatGPT, Cursor: 3
- Community Format: Python Pizza conference and newcomer talks: 3
- Coaching Focus: Increasing impact, promotions, and strategic mindset: 3
- Influencing Without Authority: Speaking different work languages & active listening: 3
- Inclusive Leadership: Defining inclusion, avoiding exclusivity, and cultural diversity: 3
- Mentoring Defined: Process, Goals & Time Commitment: 3
- Self-Education: Learning English and Computer Science: 3
- Finding cofounders and collaborators through meetups and coworking communities: 3
- DLT as a Python-based ingestion standard and market impact: 3
- DLT Plus vision and partnership outreach for freelancers: 3
- Cost-efficient pipelines: DuckDB with GitHub Actions and headless table formats: 3
- dbt's influence on engineering workflows and alternatives like SQLMesh: 3
- Decentralization in AI: Privacy, Control, and Industry Fit: 2

## Questions By Season

- Season 18: 39
- Season 19: 38
- Season 20: 122
- Season 21: 14
- Season 22: 9

## Representative Actual Questions

### background

- As always, the questions for today's interview were prepared by Johanna Bayer. Thanks, Johanna, for your help. Let's start with the main topic: AI infrastructure. But before we dive into that, could you tell us about your career journey so far? (Post-ChatGPT AI Infrastructure: Open Source Orchestration, On-Prem Economics & Distributed Training at Scale)
- Before we go into our main topic of data leadership coaching, let's start with your background. Can you tell us about your career journey so far? Also, maybe you can mention what changed in these two years – between our last interview and today? (Data Leadership Coaching: Transition to Manager, Stakeholder Skills and Team Impact)
- And finally, I want to join you in thanking Johanna for preparing the questions for today’s interview. So, thanks to Johanna for her help. Let’s start with your background. We’ll dive into the details of your experience later, but could you briefly outline your career path so far? I think I already touched on that in the intro, but maybe you could give us a short overview of your journey. (From Collider Physics to Data Science: Research Software Engineering, Interview Prep & Mentorship)
- We looked at your profile, and Johanna did a great job with that. You have such an extensive background. But let’s start with the Large Hadron Collider. You’ve participated in very large experiments with hundreds or even thousands of people. Could you share more about that experience? What did you do there, and why were so many people needed for these experiments? Also, I’ve always wondered — what exactly does the Large Hadron Collider do? (From Collider Physics to Data Science: Research Software Engineering, Interview Prep & Mentorship)
- It is not very common. You started in the semiconductors industry and then worked in software and data. Can you tell us more about your career journey so far? (From Classical Guitar to Production ML: Nonlinear Career Path Through Semiconductors, Yield Analytics & Community-Driven Learning)
- Before we dive into teaching and competitive machine learning, let’s start with your background. Can you tell us about your career journey so far? (From Kaggle Grandmaster to Production ML: Competition Rigor, System Design & Large-Scale Education)
- Do you think Kaggle is still useful for starting a data science career today? (From Kaggle Grandmaster to Production ML: Competition Rigor, System Design & Large-Scale Education)
- How did your teaching journey continue? (From Kaggle Grandmaster to Production ML: Competition Rigor, System Design & Large-Scale Education)

### current_focus

- So, the next question is: how did you begin working on AI infrastructure? But I think you've partly answered that already. You started at JetBrains, right? You saw things related to machine learning, realized there was a problem, and started working on it. (Post-ChatGPT AI Infrastructure: Open Source Orchestration, On-Prem Economics & Distributed Training at Scale)
- That leads into diversifying the business. Your main focus is on client projects, but you also set aside time for other ideas like the course. Do you do anything else? (Building a Sustainable Data Freelancing Career: Market Validation, Client Acquisition & Strategic Positioning)
- We have an audience question: How do you transition into freelancing with a three-month notice period, which is common in Germany? Projects often need short-term availability, but you might not be able to start right away. (Building a Sustainable Data Freelancing Career: Market Validation, Client Acquisition & Strategic Positioning)
- And you mentioned that you’re currently focused on mentoring, right? How did you decide to focus on mentoring? It must have been a difficult decision to switch from working to focusing completely on this, right? I know that feeling — when I was working and doing DataTalks.Club, I eventually decided to focus fully on the podcast, which felt like a leap of faith. It’s scary, right? How did it happen for you? (From Collider Physics to Data Science: Research Software Engineering, Interview Prep & Mentorship)
- Are you still involved in open-source projects? (From Kaggle Grandmaster to Production ML: Competition Rigor, System Design & Large-Scale Education)

### technical_deep_dive

- Speaking of open-source, why did you decide to work in the open? I see many companies starting as closed-source but eventually moving to open-source. Why did you choose to follow this model and make all your code open from the beginning? (Post-ChatGPT AI Infrastructure: Open Source Orchestration, On-Prem Economics & Distributed Training at Scale)
- I don’t know the full story behind OpenAI either, but I think they initially released many things as open-source. GPT-2 was open-source, and they also released Whisper and CLIP. But when they released GPT-3, they realized it was a gold mine. They thought, maybe this is something we should keep closed, but then others started reproducing GPT-3 and matching its performance. Now, OpenAI releases something, and the open-source community tries to catch up. What’s your opinion on that? With closed-source solutions like OpenAI and GPT-3, which give great performance, versus open-source solutions, where you have many different models with various characteristics and use cases? (Post-ChatGPT AI Infrastructure: Open Source Orchestration, On-Prem Economics & Distributed Training at Scale)
- Do you know if big companies, like Meta, contribute a lot to the open source community, especially in AI, with models like LLaMA? Do they publicly share information on how exactly they train their models and what their AI infrastructure is? (Post-ChatGPT AI Infrastructure: Open Source Orchestration, On-Prem Economics & Distributed Training at Scale)
- Since we’re talking about AI infrastructure, let’s focus on that. To train a model, we need thousands of GPUs. How do we get them in the first place? How do we coordinate this? These are all questions we need to consider when starting such a project. (Post-ChatGPT AI Infrastructure: Open Source Orchestration, On-Prem Economics & Distributed Training at Scale)
- So, this is what is used for models like LLaMA, right? It’s based on PyTorch? (Post-ChatGPT AI Infrastructure: Open Source Orchestration, On-Prem Economics & Distributed Training at Scale)
- When we download models from Hugging Face Hub, we use the Transformers package, right? That’s based on PyTorch? (Post-ChatGPT AI Infrastructure: Open Source Orchestration, On-Prem Economics & Distributed Training at Scale)
- And then there’s the case where many companies aren’t training models but just need to use them. If I need a model and don’t have a specific use case, I could take an existing model and fine-tune it—or maybe I don’t need to fine-tune it at all. For many companies, especially those not AI-first, the challenges are different. They’re more focused on fine-tuning and serving the model. What do you think the challenges are for these companies that are just using models rather than training them? (Post-ChatGPT AI Infrastructure: Open Source Orchestration, On-Prem Economics & Distributed Training at Scale)
- Okay, but if we already have Kubernetes, why do we need another universal tool? I remember back when Kubernetes was mentioned, I was intimidated. I didn’t want to go near it, but once I understood how it worked, it turned out to be much easier. The main challenge is that not every company has the team to manage Kubernetes. (Post-ChatGPT AI Infrastructure: Open Source Orchestration, On-Prem Economics & Distributed Training at Scale)

### business_impact

- I wish I coded more because I do a lot of operational work these days. Another thing: you mentioned freelancing as a lifestyle business. What exactly do you mean by that? (Building a Sustainable Data Freelancing Career: Market Validation, Client Acquisition & Strategic Positioning)

### organizational_reality

- I want to apologize for going off script, but isn’t it fun? You mentioned staying one and a half years on average at companies. I had a similar situation until I found a company where I stayed much longer. Do you think staying around a year to a year and a half is becoming the new norm? (Building a Sustainable Data Freelancing Career: Market Validation, Client Acquisition & Strategic Positioning)
- Going back to your idea of “You cannot eat too much pizza – six, seven slices at most. And the same with the team – you cannot manage more than six, seven people at once.” Right? (Data Leadership Coaching: Transition to Manager, Stakeholder Skills and Team Impact)
- What do you actually do as a coach? One thing you mentioned is that you organize these feedback sessions (team trainings) where the entire team learns how to (Data Leadership Coaching: Transition to Manager, Stakeholder Skills and Team Impact)
- Should we do competitive machine learning alone or in teams? (From Kaggle Grandmaster to Production ML: Competition Rigor, System Design & Large-Scale Education)
- Do students work individually or in teams? (From Kaggle Grandmaster to Production ML: Competition Rigor, System Design & Large-Scale Education)
- You keep saying we. Who do you mean? Your husband and you or somebody else in the team? (Building Pet Health Tech: ML, Sensors, and Dog Behavior Data)
- Why did you move to London? Is it related to your company or did it just happen? (Building Pet Health Tech: ML, Sensors, and Dog Behavior Data)

### practical_advice

- I see you have a section of top-paying skills. The first is "data management" ($120/hour), then "AI development" ($116/hour). What is data management? (Building a Sustainable Data Freelancing Career: Market Validation, Client Acquisition & Strategic Positioning)
- Because like I have a totally different context, they're busy with other stuff, and they don't have time to really go deep into your problem and then give you advice. Right? (Data Leadership Coaching: Transition to Manager, Stakeholder Skills and Team Impact)
- So do you think we can learn these skills? If I'm a senior data scientist and, all of a sudden, I find myself in this situation where I need to figure out what to do without being told and I'm expected to actually not be told but figure things out . What's the most effective way of learning this? You mentioned that, “Okay, I'm an engineer. I can figure this out as I go.” Which is what most people probably do. But this is not always the best… the most optimal strategy. But is this the only strategy or can we do it better? (Data Leadership Coaching: Transition to Manager, Stakeholder Skills and Team Impact)
- Is this something you also recommend your clients to do – the retrospective? (Data Leadership Coaching: Transition to Manager, Stakeholder Skills and Team Impact)
- That's such a good piece of advice. I regularly find myself in this situation, when somebody approaches me and says, “Hey, we want to invite you to talk at a data conference.” And then like, “Okay, I've stopped being an individual contributor like four years ago and all I did was talk to people as a data science lead. What am I supposed to talk about?” (Data Leadership Coaching: Transition to Manager, Stakeholder Skills and Team Impact)
- Okay. If anyone needs a coaching session from Tereza, you will find the link on your LinkedIn profile. Right? Okay. So, thanks again, and goodbye. (Data Leadership Coaching: Transition to Manager, Stakeholder Skills and Team Impact)
- Recommendation? Well, right now I’m reading The Boy in the Striped Pajamas. (Inside Scaling DataTalks.Club: How We Built Free Data Engineering, MLOps & LLM Courses)
- That’s great! Tell us more about your mentoring work. I see there's a related question that might connect with what you’re doing now. Someone asked how to convince German companies in this field, as they’ve had multiple interviews but keep getting rejected without feedback. What advice would you give? (From Collider Physics to Data Science: Research Software Engineering, Interview Prep & Mentorship)

### future_outlook

- Since you find these reports entertaining, I’m curious—what challenges do these companies face, and do these challenges also apply to smaller companies? Larger companies like Meta, Google, and OpenAI have different challenges from smaller ones, right? What are these challenges in general, and how do they affect trends in AI infrastructure? (Post-ChatGPT AI Infrastructure: Open Source Orchestration, On-Prem Economics & Distributed Training at Scale)
- Here's a question: Do you think the future will be a hybrid of bare metal and cloud, or will it be cloud-only? (Post-ChatGPT AI Infrastructure: Open Source Orchestration, On-Prem Economics & Distributed Training at Scale)
- You’ve been in the industry for a while and seen trends change. A few years ago, MLOps was popular, but now it seems less so. The problems remain, but AI and new terms are more popular. What is hot in the market now for freelancing? (Building a Sustainable Data Freelancing Career: Market Validation, Client Acquisition & Strategic Positioning)
- What trends do you think we’ll see more of in 2025 and beyond? (Modern Data Engineering: Iceberg, Delta Lake & AI-Powered Pipelines)
- What’s the future of DLT? (Modern Data Engineering: Iceberg, Delta Lake & AI-Powered Pipelines)

## Incorporation Notes

- These are transcript questions actually asked by Alexey, not draft prep questions.
- They are often shorter, more reactive, and more conversational than prep-doc questions.
- They frequently follow up on what the guest just said, so context headers are preserved.
- Use this bank to calibrate phrasing and rhythm; use prep docs for planned arcs and topic coverage.
