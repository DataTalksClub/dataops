---
id: 2025-12-08-sofya-yulpatova
status: archive
date: 2025-12-08
date_raw: 2025-12-08
guest_name: Sofya Yulpatova
topic: Building Pet Health Tech: ML, Sensors, and Dog Behavior Data
source_quality: partial
source_path: podcast_examples/Podcast/Archive/2025-12-08 - Sofya Yulpatova - Building Pet Health Tech_ ML, Sensors, and Dog Behavior Data.docx
themes: ["career_transition", "human_centered_ai", "applied_ml", "education_community", "mlops_production", "data_platforms", "domain_applications"]
question_categories: ["story_moments", "practical_advice", "topic_selection", "background", "current_focus", "resources", "reflection"]
---

# Sofya Yulpatova - Building Pet Health Tech: ML, Sensors, and Dog Behavior Data

## Bio

Sofya Yulpatova is the Founder and CEO of Fit Tails, a PetTech startup developing an activity and health tracker for pets. She has a background in computer science, machine learning, and product management, and previously managed product and delivery operations at FixParts, an international automotive parts distributor. Sofya studied at the University of Latvia and completed the Sales and Marketing Programme at the Stockholm School of Economics in Riga. Links:

## Links

- linkedin: www.linkedin.com/in/sofya-yulpatova (http://www.linkedin.com/in/sofya-yulpatova)
- website: https://www.fit-tails.com/

## Themes

career_transition, human_centered_ai, applied_ml, education_community, mlops_production, data_platforms, domain_applications

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
- Which assumptions about human activity recognition were completely invalid when applied to dogs?
- Which aspect of dog health was the hardest to model, and why?
- Which hardware or firmware limitations most impacted your models, and how did you optimize your approach to these constraints?
- When validating behavioral patterns with veterinarians, how do you blend their clinical expertise with data-driven insights without letting either dominate or skew the model?
- What’s one modeling challenge in this field that you feel deserves more open discussion?

## Sections

### Guest Tab

These notes help us draft focused questions and an event description.

### General Questions

How would you like us to introduce you?

What are you currently focused on—projects or themes you’d enjoy discussing?

Which topics are you most keen to cover?

Are there any topics you’d rather skip or avoid discussing publicly?

### Links

LinkedIn: www.linkedin.com/in/sofya-yulpatova (http://www.linkedin.com/in/sofya-yulpatova)

Twitter: -

Github: -

Website: https://www.fit-tails.com/

LinkedIn: www.linkedin.com/in/sofya-yulpatova (http://www.linkedin.com/in/sofya-yulpatova)

Twitter: TODO

Github: TODO

Website: TODO

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

Thank you for the invitation! I chose to focus on a more personal story. If you need any details from me, feel free to reach out, and I will try to provide the information you need as soon as possible. 🙂

## Give a one-sentence snapshot of the moment that set this journey in motion (happened to be blend of 1-3 for me)

Basically, I started Fit-Tails because of my own dog Morty. I never had dogs before her, so she was almost a first-time baby for me (I am sorry to every parent of a human baby, but we pet parents really feel this way). My husband and I adopted this dog from the breeder, thinking that it would be safer for us, as first-time dog parents, to have a really healthy dog, because we were really afraid of any health issues.

As it always happens, everything turned out differently: it turned out that she had (and still has) a severe allergic reaction. My husband and I back then were working together in the office, and they weren’t pet-friendly at all, so we had to leave her at home for a prolonged period of time. Unfortunately, her allergy symptoms showed up in several ways: her nose and paws would crack, and infections could get (and the most times got) into the wounds 🙁

We were very worried about that, so we went to the vet at least twice a month and spent more than 5K in vet bills trying to find out what could help and what the reasons were. Most of the money went toward curing the symptoms and infections that happened so dramatically and fast. But the most difficult thing for us was the guilt that we didn’t notice it in the very beginning.

We, of course, bought 360-degree cameras for our flat and were obsessively checking them, but still, you somehow need to work also and you can’t just watch your home cameras 24/7 (i would love to tho).

So we found out that some kind of dog trackers existed. We tried the first one - did not work, we tried the second one - same. We ended up getting every version (even the ones that worked only in the US, we asked our friends to ship them to us). So our dog looked like a Christmas tree, but none of them showed anything. At this point we thought: this is enough, we will build it ourselves 🙂

So here we are :)))

## Which events, successes, or stumbles taught you the most?

There are actually a lot of them, but I will try to shorten everything 🙂

One of the big lessons for me was realising that almost nothing in a dog’s health actually “starts randomly”. I used to think Morty’s allergy just appeared out of nowhere. One day she looked completely fine, we played a lot, and the next day we were suddenly dealing with cracked paws and infections. But when we started collecting data from the prototypes and talking to veterinarians who were advising us on health patterns, I kept hearing the same message: there are almost always early signs, we just don’t notice them with the naked eye.

And then we saw it in the data. Morty had restless nights, more awakenings. No one would ever notice that in real life - we, unfortunately, need to sleep ourselves. We also saw similar micro-shifts in other dogs. For example, a dog scratching their head every morning doesn’t mean they are “feeling funny” or don’t want to wake up. It is often irritation and an early ear infection. Once veterinarians explained how changes in sleep and tiny behaviour patterns often reflect early discomfort or inflammation, everything clicked.

Every vet will tell you that sleep is one of the most important indicators of how a dog is doing. More specifically, sleep continuity, night awakenings, and restlessness. But there is no realistic way for an owner to track that. Many owners don’t even know exactly how much food their dog eats in a day, so expecting them to assess sleep quality is simply impossible.

It was the same story with behaviour. Dogs become just slightly less playful, settle slower in the evenings, or pace in tiny patterns that look completely normal to us but show up as clear changes in the IMU data.

And overall, seeing the patterns in the data, living through it with Morty, and having veterinarians validate that these tiny things actually mean something was a huge turning point for me. It made me understand that the body always whispers long before it screams, and those whispers appear in sleep and everyday behaviour long before any “big symptom” shows up.

—-------------

If we go a bit more into the specific challenges I discovered when working with data collection, it is how different the dogs truly are. If we look at the “role model” of animal activity recognition - human activity recognition, people are less different (sorry!). Of course, by nature, behaviours, and habits we are different from each other, no doubt. But biomechanically, humans are still relatively similar. We do not have a world where one adult is twenty times larger than another…

With dogs, this is normal. You have a 3-kilogram Dachshund and a 60-kilogram Kangal. Their mass, limb proportions, gait patterns, and even center of gravity are completely different. And size is only one source of variability. Dogs also differ in energy levels, coat thickness, collar or harness fit, daily routines, and behaviour patterns. Even small things like how the device rotates on the neck or how loose the collar is will change the IMU orientation and distort the raw signal.

From an ML standpoint, this makes data collection extremely demanding. To train a model that can generalise across breeds, we need large amounts of data not only for the activity classes, but also across different “types of dogs” - sizes, morphologies, ages, temperaments, lifestyles, disease-related movement patterns. Without capturing this variability, the model will experience domain shift and fail in the real world.. So we need the data from the senior dogs, young puppies, anxious dogs, overweight dogs, underweight dogs, dogs going through treatments, and dogs with medical conditions. And that is before we even talk about labelling, which is its own pain.

And then there is the behavioural side. Dogs are basically babies. You cannot explain to them: “please do not drag the furniture onto the sensors, and ask your sister not to remove the collar with her shark claws.” They run through bushes, roll on the floor, attempt home renovation while you are away, and of course our favourite - they sleep in positions that violate physics. As a result, the device rotates, slips, gets stuck under the neck (hello Bassets), flips upside down, or ends up pointing in a completely random direction. In other words, dogs unintentionally stress-tested every aspect of our engineering choices.

But the important thing is that all of this is their real and natural behaviour, which we adore. A model is only as good as the data you can collect in the real world. Real data is messy, unpredictable and funny and sometimes completely absurd. And that messiness is exactly what makes this entire project challenging and fascinating at the same time.

And yes, for labelling we need to mount a camera on the dog. Not every pet parent gets excited about that :))))))

—--

## Who might recognize their own journey in yours?

I think a lot of early-stage founders might recognise parts of my journey, especially the ones who spent a long time trying to “fit” into a normal, stable job before realising that the thing they actually cared about was the thing keeping them up at night. For me, it wasn’t some glamorous moment of ‘I woke up and decided to build a startup’. It was more like this slow, messy realisation that everything I was doing outside of work was starting to matter to me more than my actual job.

I would totally say it is the same for anyone who is trying to change their career. It always feels like “it’s too late and risky” or “I have obligations” or “it’s too scary to start over”. Those thoughts don’t go away- you just get to a point where staying where you are feels even scarier, and you can just have everything at the same time.

At some point, I caught myself thinking about Fit Tails during meetings that had nothing to do with Fit Tails at all. And there comes this moment where you realise you are basically doing two jobs, except only one of them feels alive.

So eventually it became obvious that I had to either commit fully or stop pretending it was just a “side project.” It was terrifying, if I am being completely honest. Leaving something stable, changing your whole life structure, and jumping into a problem that is technically hard, emotionally heavy, and financially very uncertain is not exactly the easiest decision :)

But the alternative is pretending that I didn’t care, pretending that this wasn’t what I wanted to build, pretending that I could just “let it go” was even harder. Once you truly see a problem you deeply believe should be solved, it becomes impossible to ignore, so I did the thing that every founder both dreams about and panics over: I left my job and decided to pursue Fit Tails full-time.

And I think anyone who has ever left stability behind to build something that keeps pulling them forward (like their own life), even when it sounds crazy, even when it feels too early, even when the risk is enormous - will recognise this feeling immediately.

##not really short about me (sorry)

My background is actually a mix of tech, product, and a bit of “life forcing me to grow up faster than expected.” I won’t go into the personal details too much, but moving countries and starting from scratch meant that studying and working at the same time was simply the only option. I was always interested to tech, even as a kid: my first real “project” was a little “craft your bouquet” webiste (we all start here i guess) I made when I was around fourteen. I still remember how proud I was of that. (i found the project a year ago, and ran it….. it was terrible from all the perspectives)

I started with programming, and I genuinely loved it when I could sit alone, get obsessed with a small idea, and build something from scratch. But the moment coding became a job full of tasks I wasn’t allowed to be creative with - just “deliver this, don’t overthink it”. I realised that the professional coding world didn’t feel like home to me. I wanted to spend more time shifting strategies, analysing the market, building products, talking to people, understanding problems, and piecing things together in my daily job, not hobby.

So I moved toward product management. At first in a small consulting company (where I made the classic mistake of helping with coding “just a little bit,” which obviously turned out poorly). And then I joined an automotive SaaS company. That job, honestly, was like a full-on bootcamp for becoming a founder. We were building an ERP and CRM platform from scratch. I talked to clients, mapped processes, ran interviews, built the team (I miss them a lot), dealt with ten-year-old legacy systems… it was intense and incredibly educational, cause you can observe the people, and learn “how is it done”.

At the same time, I was studying computer science at the University of Latvia, mostly focusing on machine learning. I have to give a huge round of applause to my lecturer, Maksims Ivanovs, because without him I probably would not have interest in ML at all. Even outside university, I kept learning: doing ML courses, building projects from scratch, asking people from my network endless questions, and basically annoying half the university :)

So that was my life: work, studies, and then ML projects at night. Not much sleep :)

And then there was Morty. And everything changed.Her allergy issues triggered that deep feeling of panic and guilt that only pet parents really understand. I’m a very tech-savvy person myself. I wear an Oura ring, an Apple Watch, I track my food… I’m obsessed with data. So of course, the first week I was like: “Why do I have all this visibility for myself, but nothing for my dog?”

Yes, I blamed myself when something happened to her, because I’m her parent, and I’m responsible for her. And everything with Fit Tails started from that place: wanting to understand her better, wanting to see what I couldn’t see with my eyes, and realising that the early signs were always there… just invisible to humans.

Eventually I reached that classic founder crossroad, when I was basically doing two jobs: my “normal job” and the work on Fit Tails. I was terrified to leave stability behind (especially because I wouldn’t contribute financially to the family for a while), but the alternative of pretending I didn’t care felt worse. My husband supported me completely, so I took the leap and decided to pursue Fit Tails full-time.

## What’s your current role, and what single experience ties you to this theme?

Right now at Fit Tails I’m basically an octopus doing everything, as every early-stage founder does. I’m the ML person, the R&D, the marketing, and the “why is the prototype vibrating at 3am”. Huge thanks to our small team of octopuses - I’m definitely not doing this journey alone.

On the ML side, my work is a bit more than just “building models”. It’s looking at the IMU signals, cleaning them up, spotting patterns, and trying to understand what the dog is actually doing. A lot of it is trying to figure out whether a strange movement is a real sign of discomfort, a change in their usual behaviour, or simply the dog being dramatic again. It is incredibly important to me to incorporate veterinary science: I share the patterns with veterinarians and ask whether something is clinically meaningful or just typical dog mood swings for example. Their feedback shapes how we interpret signals and what we treat as a real deviation.Morover, a big part of my job is making sure the things we detect on one dog still make sense on another - whether it’s a Dachshund, a Labrador, or a Shepherd. Dogs are incredibly different, so testing across sizes, shapes, and lifestyles is essential. And of course, we deal with the beautiful world of real-world data :) collars rotating, slipping, or ending up sideways because the dog decided to roll in something questionable again.

If I had to pick one experience that ties me to this work, it’s a mix of the dog-parent instinct and the pure happiness when the signal finally “clicks” and tells you a story.

## If listeners remember one idea next week, what should it be?

If there’s one idea to keep: dogs communicate everything, just not in a human way :) All the early signs live in their behaviour and sleep, not in late-stage symptoms. There are so many small changes that matter when you analyse and understand pets, and paying attention to those early signals is essential if we want our babies to live happier and longer.

And for people who don’t have dogs: Don’t be scared of big decisions. Start with the small steps, the tiny purposes, and once something feels “too interesting but also risky,” trust that feeling. If you’re already thinking about flipping a coin you have already decided, but just waiting for permission. So give that permission to yourself and go for it :)

### Rough Plan

Overall duration – up to 1 hour

Intro (5 minutes)

Prepared questions from me about the topic (30-40 minutes)

Questions from the audience (the remaining time)

### Event Description

Title: Building Pet Health Tech: ML, Sensors, and Dog Behavior Data

In this podcast episode, we’ll be joined by Sofya Yulpatova, Founder and CEO of a PetTech startup building what many describe as an early version of the “Apple Watch for dogs.” Her work sits at the intersection of machine learning, sensor data, and real-world behaviour patterns, and she brings a refreshingly honest view of what it takes to make pet health measurable.

We'll discuss the challenges in animal health technology compared to human wearables, such as dogs' unpredictable behavior and the difficulty of collecting useful data. Sofya will explain why many early health signals are often undetectable by owners but clear in the data.

We’ll also cover the technical side, including developing models for different dog breeds, managing sensor noise, and creating feedback loops with veterinarians and pet owners.

Topics we plan to explore:

Why sleep patterns may be the strongest and most overlooked health indicator

How small daily behaviour changes can reveal early discomfort

The realities of collecting embedded sensor data in the real world

Challenges around calorie estimation, device variability, and multi-dog generalization

Lessons from early prototypes and testing with real pets

This episode explores how machine learning, sensor data, and behavioral science intersect, demonstrating how applied machine learning can advance pet health technology to meet expectations similar to those of human wearables.

### Bio

Sofya Yulpatova is the Founder and CEO of Fit Tails, a PetTech startup developing an activity and health tracker for pets. She has a background in computer science, machine learning, and product management, and previously managed product and delivery operations at FixParts, an international automotive parts distributor. Sofya studied at the University of Latvia and completed the Sales and Marketing Programme at the Stockholm School of Economics in Riga.

### Speech

Introduction:

Welcome back to the DataTalksClub podcast. Today, we’re exploring a type of real-world data that most of us rarely work with but find fascinating—the behavior and daily habits of our pets.

Our guest is Sofya Yulpatova, the founder and CEO of Fit Tails, a PetTech startup developing what many refer to as the early version of an “Apple Watch for dogs.” Her work sits at the intersection of machine learning, sensor data, and behavioral science, and it started from something very personal.

Sofya’s journey began when her own dog, Morty, kept experiencing health issues that no device could explain. She tried every tracker available, but none of them worked. So she started examining the signals herself, and that curiosity gradually led to a prototype… which grew into a company.

Today, she and her team are developing models capable of working across a wide variety of dogs, handling messy, real-world signals, unpredictable behavior, and data-collection challenges.

Sofya, thank you for joining us.

Before we dive into the technical aspects of pet behavior modeling and sensor data, let’s start with you. Can you walk us through your background and how this entire journey began?

Questions:

You began gathering your own data because the existing trackers offered minimal useful insights. From an ML standpoint, what do you believe those devices fundamentally lacked—whether in the data, the modeling, or the interpretation of signals?

You’ve mentioned collar rotations, device flips, and dogs moving unpredictably. What preprocessing techniques or representation strategies helped you stabilize these chaotic signals?

Which assumptions about human activity recognition were completely invalid when applied to dogs?

You highlighted the wide variation among dogs — from the 3 kg Dachshund to the 60 kg Kangal. What techniques helped your models generalize across these biomechanical differences?

Which aspect of dog health was the hardest to model, and why?

You collected ground truth data with mounted cameras in uncontrolled environments. What did you learn about designing an annotation pipeline when your subjects move unpredictably, don't follow rules, or leave the frame?

Which hardware or firmware limitations most impacted your models, and how did you optimize your approach to these constraints?

When validating behavioral patterns with veterinarians, how do you blend their clinical expertise with data-driven insights without letting either dominate or skew the model?

Have you encountered situations where the model identified a pattern that vets hadn’t considered, or where vets noticed something the model entirely missed?

After working with noisy, real-world sensor data from highly variable subjects, what do you believe many ML practitioners underestimate about applied machine learning?

What’s one modeling challenge in this field that you feel deserves more open discussion?

If unlimited labeled data across breeds, ages, lifestyles, and health conditions were available, which new models or signals would you most want to explore?

Looking into the future, what do you envision pet health technology becoming once it reaches the maturity level of human wearables?
