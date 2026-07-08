---
tags: [ppe, guide, beginner]
---

# Beginner Guide

> Read this first. It explains the entire project in plain language, assuming no computer‑vision or machine‑learning background. Every idea here is expanded in a linked note when you're ready to go deeper.

## What is this project, in one sentence?

It's a piece of software that looks at a photo of a meal and tells you the calories, protein, carbs, fat, and micronutrients — and it does this accurately by **measuring the real size of the food** instead of guessing it.

## Why is "measuring the size" the whole point?

Here is the problem that makes nutrition apps bad at portions. Look at a photo of a plate of rice. Is that 200 grams or 400 grams? You genuinely cannot tell from the pixels alone, because **a camera has no sense of absolute scale.** A small plate photographed up close and a big plate photographed from far away can produce the *exact same image*. This is not a limitation of today's AI — it's a law of optics. One photo simply does not contain the information.

Identifying *what* the food is (rice, chicken, broccoli) is basically a solved problem — modern vision models hit ~93% accuracy. But **how much** there is — the portion — is the open problem, and it's the thing that actually determines the calorie number. Google measured this precisely with a dataset called Nutrition5k: a model guessing from a normal photo is off by about **26%** on calories, but the moment you give it a real depth measurement of the food, the error drops to about **16.5%**. That 10‑point gap is *pure scale information*.

So the question this project answers is: **how do you get that scale information on a normal phone, without special hardware?**

## The big idea: get scale from physics, not from a guess

Fancy phones (iPhone Pro) have a LiDAR depth scanner that measures size directly. But most phones don't. The insight here is that **every** modern phone already knows real‑world distances — because of the same technology that powers the "Measure" app on your phone.

Here's why that works. Your phone has an accelerometer (a motion sensor). It measures acceleration in real physical units — meters per second squared. When you move the phone, the phone's software combines that motion with what the camera sees, and it can solve for real distances in **meters**. This is called *visual‑inertial odometry* (VIO), and it's why the Measure app can tell you a table is 1.2 m wide. The scale comes from **Newton's physics** (the accelerometer feeling real forces), not from a neural network's guess about how big plates usually are. That's the "physics‑powered" in the name.

So the plan is:
1. The user points the phone at their meal and does a quick **2‑second ruler gesture** — tap, hold, and slide a finger to draw a line across the plate (or up the side of the food). The phone turns that gesture into a real measurement in centimeters, using the physics above.
2. Now that we know the true scale, the rest is **geometry we can write down as equations** (no guessing): outline the food, measure its area and height, compute its volume, multiply by density to get grams, and look up the nutrition.

## How a photo becomes a calorie number (the pipeline)

Think of it as an assembly line. Each station does one job:

```
  [1] CAPTURE  →  [2] SEGMENT  →  [3] CLASSIFY  →  [4] PORTION  →  [5] NUTRIENTS
   (the ruler)     (outline it)    (name it)       (measure it)    (look it up)
```

1. **Capture** — the AR ruler gesture. Produces a photo + the camera's exact position + the ruler measurements. This is [[The Capture App]]. It's pure geometry, no AI.
2. **Segment** — draw the outline around each food on the plate ("this blob is one item"). A neural network. See [[Segmentation Model]].
3. **Classify** — put a name on each outlined blob ("white rice, cooked"). Another neural network. See [[Segmentation Model]] and [[MODELS]].
4. **Portion** — the heart of the project. Using the measured scale, compute each food's **area** (cm²) → **volume** (mL) → **mass** (grams). This is math, not AI: [[Math 3 - The Plane Homography]] and [[Math 4 - Volume Mass and Nutrients]].
5. **Nutrients** — look up the food's calories/macros per 100 g in a database (USDA), scale by the mass, and add it up. See [[Nutrition Database]].

The output is a per‑item breakdown with an **honest error band** ("~160 g ± 35 g"), because the whole design philosophy is *the app proposes, the user confirms* — it never pretends to be more precise than it is.

## Where does machine learning actually come in?

Surprisingly little, and that's on purpose. Steps 2 and 3 (outline + name) use existing, off‑the‑shelf models. Step 4 (the portion math) is deliberately **not** a neural network — it's ~300 lines of geometry that you can test to nine decimal places against synthetic scenes with known answers. That's a huge reliability win.

There is exactly **one** model this project trains from scratch, because nothing like it exists publicly: a small network that predicts **mass** from the food's appearance *plus the measured scale*. It's a clever design (a "FiLM" conditioning trick — see [[Mass Regressor Model]]) and it's optional — a smarter fallback for when the pure geometry is uncertain.

## What's built, and what's next?

A lot is already done and tested: the entire geometry math library, the pipeline that ties everything together, the nutrition database builder, and the Android capture screen (with a genuinely fun "45‑pound gym plate" button you hold to measure). See [[Roadmap and Next Steps]] for the current state, or the authoritative [[STATUS]].

What's in flight: training the models on Google's GPUs, and physically testing the ruler against a real tape measure and kitchen scale.

## Where to go next

- Curious *why* the scale problem is fundamental and how VIO cracks it → [[The Problem and The Big Idea]].
- Want the map of the whole system → [[System Architecture]].
- Want the actual math, taught from zero → start at [[CS Foundations]], then [[Math 1 - Metric Scale and the Pinhole Camera]].
- Want to read the real code → [[Geometry Library]] and [[The Pipeline]].

## Related
- [[Home]] · [[The Problem and The Big Idea]] · [[System Architecture]] · [[Glossary]]
