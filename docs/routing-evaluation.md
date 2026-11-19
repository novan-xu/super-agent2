# Routing unassigned owner messages without a model call: evaluation (#139)

This report holds aggregate numbers only. No message text is in it. The labels, the full output of the tool and a
per-message listing of every decision stay on the owner's PC in `C:\Users\nuofa\.superagent2\route-eval\`.

## Recommendation

Route in the hub with a **character-bigram score** (no model), tuned for few wrong joins. A wrong split leaves the
owner a one-tap "move to" hint; a wrong join leaves none and pollutes the topic's context, so the constants below are
the ones chosen on the train part with a wrong join counted **three times** as bad as a wrong split (weights 3 and 4
choose the same constants). In this order, among the in-scope topics active in the last 24 hours:

| Step | Rule | Constant |
|---|---|---|
| b | The message has at most **12 characters** and the most recently active topic was active at most **30 min** ago: join it. | 12 characters, 30 min |
| c | Score every active topic: the best bigram cosine between the message and the topic's text (its first message, its last 5 owner messages and its last 3 replies, each reply clipped to 320 characters), minus **0.18 × log2(1 + idle / 10 min)**. Join the best topic if its score is at least **0.055** and leads the runner-up by at least **0.091**. | 0.055, 0.091, 0.18 |
| d | Otherwise open a new topic, with a hint naming the best-scoring topic. | — |

The bigram representation: NFKC, lower case; each run of `[a-z0-9_.#-]` of two or more characters is one unit; in the
rest, after dropping punctuation, symbols and spaces, every pair of adjacent characters is a unit; each unit weighs
`1 + ln(count)`; the vector is normalised and two texts are compared by cosine. The owner's message is clipped to its
first 1 000 characters.

Expected on new messages (the later 40 % of both histories, 154 messages that would reach the router): **about 62 %
right, 7 % wrong joins and 31 % wrong splits** (11, 48 and 95 of 154; error rate 31–46 % at 95 %), against 79 % wrong
splits today. Of the 11 wrong joins, 6 come from rule b and 5 from the score.

With wrong joins counted twice instead of three times, the train part chooses two more rules before b (a reply ending
with a question, and references to tickets and issues; both defined below) and a smaller margin. That router is right
more often but makes almost twice the wrong joins:

| Step | Rule | Constant |
|---|---|---|
| a | The most recently active topic's last assistant reply ends with a question (`?` or `？` in its last line, within its last 40 characters) and that topic was active at most **30 min** ago: join it. | 30 min |
| e | The message names a ticket or issue (`tkt_…`, `T-n`, `#n`, `工单 n`, `PR n`, or a bare 2–4 digit number that is not a time, percentage or quantity) that appears in exactly **one** active topic's messages or replies: join that topic. | — |
| b | As above. | 12 characters, 30 min |
| c | As above, with a margin of **0.023**. | 0.055, 0.023, 0.18 |

It is **about 70 % right, 13 % wrong joins and 18 % wrong splits** (107, 20 and 27 of 154; error 24–38 %). Of its 20
wrong joins, 15 put the message into another active topic and 5 should have opened a new one; of its 27 wrong splits, 14
belonged to the most recent topic and 13 to an older active one. Rules a and e are right about three times in four
(13 of 17 and 12 of 15 on the test part). That is close to the break-even once a wrong join costs three wrong splits
(a join then pays only if it is right more than three times in four), and on the train part they did not pay.

**Why bigram and not a model.** With wrong joins counted twice, the bigram router, `bge-small-zh-v1.5` and `bge-m3` are
tied: their costs (2 × wrong joins + wrong splits) are 67, 63 and 66 on the test part, and the paired bootstrap
interval of each model's difference to bigram contains zero (bge-small-zh −16 to +7, bge-m3 −17 to +15). With wrong
joins counted three or four times, bigram and bge-small-zh are tied again (11 against 10 wrong joins, 48 against 51
wrong splits; see "At the same wrong-join rate" below). The issue asked for the simpler scorer when the difference is
small; "small" was taken to mean that the 95 % interval of the paired difference contains zero. The bigram router also
held its accuracy from the train part to the test part, so its constants are the least overfitted.
`bge-small-zh-v1.5` remains the fallback: about 2 ms per message here and 41 ms on the NAS, and it runs on the NAS (see
below).

**What I would not do.**

- Do not use `multilingual-e5-small`: it was the weakest scorer (cost 77, 62 % right on the test part).
- Do not use `bge-m3`: no better than bigram, 560 MB of model files, 0.7 s per message on the NAS.
- Do not use a hard recency window for the score: with a window instead of the decay every scorer lost 5–16 points.
- Do not rely on a margin alone: margin without an absolute threshold lost 1–12 points, depending on the scorer. With
  wrong joins counted twice the margin adds little on top of the threshold; with three times it is what keeps the
  score from joining near ties.
- Do not score short messages. For messages of at most 10 characters every scorer ranks the true topic first only
  19–26 % of the time, against 81 % for "the most recently active topic". Rule b handles them, and the score changes
  none of their outcomes.
- Do not route messages that already carry their topic: answers given on a ticket's page and the 开始/编排 buttons of a
  card. In the first Super-agent these were 176 of 518 owner messages; replayed through the router they add wrong joins.
- Do not widen rule b: longer limits (20 characters) and longer idle times (2 h) were in the search and were not chosen.

## Decision taken for #143

The session that wrote the implementation issue (#143) chose differently from the recommendation above:

- **Primary router:** `bge-small-zh-v1.5` with the constants chosen on the train part with a wrong join counted twice:
  rules a, e and b, then the score with threshold 0.570, margin 0.096 and decay 0.048 (13 wrong joins and 37 wrong
  splits on the test part).
- **Fallback and shadow:** the strict bigram router (rule b; threshold 0.055, margin 0.091, decay 0.18) decides when the
  model is unavailable, and otherwise runs beside the primary with its decision recorded.
- **Record:** every routing decision is stored in the database, so the owner's corrections become labels.

Cost on the test part (154 messages) at each weight of a wrong join; the chosen router is the lowest at all three:

| Router | Wrong joins | Wrong splits | 2 × joins + splits | 3 × | 4 × |
|---|---|---|---|---|---|
| bge-small-zh, constants chosen with weight 2 (chosen) | 13 | 37 | 63 | 76 | 89 |
| Bigram, constants chosen with weight 2 | 20 | 27 | 67 | 87 | 107 |
| Bigram, constants chosen with weight 3 (strict; recommended above) | 11 | 48 | 70 | 81 | 92 |
| bge-small-zh, constants chosen with weight 3 | 10 | 51 | 71 | 81 | 91 |

It makes about as few wrong joins as the strict bigram router (13 against 11) with 11 fewer wrong splits, and
fragmentation was the owner's original complaint. With only the threshold moved, bge-small-zh leaves fewer wrong splits
than bigram between 8 % and 11 % wrong joins on both parts: on the test part at 13–16 wrong joins of 154 (36–34 against
57–49), on the train part at 20–25 of 234 (73–50 against 75–61), level at 19 (8.1 %). Below 8 % bigram is level or
better on both parts (test 12 wrong joins: 64 against 57; train 15–18: 85–91 against 80–90).

This is not statistically established. The paired bootstrap intervals under Results contain zero for the cost difference
between bge-small-zh and bigram with weight-2 constants and for both kinds of error with weight-3 constants, the matched
curves were drawn with the threshold moved on the very messages they are measured on, and the evaluator's
recommendation was the strict bigram router. The shadow record exists to settle the choice on real use.

## Data

| Data set | Source | Period | Owner messages | Routed (scored) | Topics | Median messages per topic | One-message topics | Messages ≤ 10 characters |
|---|---|---|---|---|---|---|---|---|
| Super-agent2 | production `hub.sqlite`, copied live with `VACUUM INTO` on 2026-11-18 20:46 EST | 2026-11-18 01:54 – 20:23 EST | 46 | 46 | 13 | 3 | 5 | 6 |
| First Super-agent | its `hub.sqlite` (containers stopped since 2026-11-17), byte copy | 2026-11-07 – 2026-11-17 | 518 | 342 | 90 | 3 | 21 | 86 |

For the first Super-agent the owner's messages are the stream (`stream_items` of kind `owner`: 418 from the web page,
the desktop app and Lark) and the front door (`chat_messages` with direction `in`: 100, one duplicate of a stream
message dropped). `chat_messages` alone holds only 101 of them. The replies used as topic text and for rule a are the
stream's `reply`, `confirm`, `ticket` and `handoff` items and the front door's outgoing messages (892 in all; 154 end
with a question, 79 are confirmation cards). Super-agent2 has 85 assistant replies; none of them is a question card, so
rule a there rests on the text alone.

**These are small data sets.** The test part has 154 routed messages (136 and 18); the 95 % interval of an error rate
measured on them is about ±7 points, and differences of fewer than about 15 cost points between two routers are within
noise. Super-agent2 contributes too few messages to be judged on its own; its numbers are shown but should not be read
separately.

## Labels

Super-agent2's topic assignment is not ground truth: 37 of its 46 messages sit in the single conversation of the time
before topics, and the 9 later ones each opened their own topic because routing never worked. No topic has been merged
by hand (`merged_into` is empty).

The first Super-agent's `conversation` is owner-chosen only for messages sent with a ticket: such a message goes to that
ticket's conversation (`apps/hub/src/sources/chat.ts`); a message without a ticket always opens a fresh random
conversation, whatever its subject. The 88 ticket-addressed messages form 41 groups. They were taken as given: each group
received a single label, the topic in which its ticket was started.

Everything was then labelled by reading the owner's messages in time order with the replies between them, by the
implementer of this evaluation, once, with these rules:

1. A topic is one subject of work or discussion the owner would want kept in one context: one feature, bug, ticket,
   question or project task, with its follow-ups.
2. A message that answers or responds to the content of an assistant reply belongs to that reply's topic, including
   acknowledgements, choices, corrections and short replies.
3. A message that brings up a subject not under discussion in any active topic starts a new topic, even inside the same
   project, and even when it begins by acknowledging the previous reply.
4. A message about a ticket, issue or item belongs to the topic where that item was started, when that topic is active.
   A side remark made in passing does not make its topic the item's home.
5. A message covering several subjects is labelled with its main request; when it continues several topics equally, with
   the most recently active of them.
6. A card button (`开始：…`, `编排：…`, `全部开始`, `开始所选`) belongs to the topic of the card's proposal.
7. A message that returns to a subject idle for more than 24 hours keeps that subject's label; the replay expects a new
   topic for it anyway, since archived topics are not candidates.
8. Test and acceptance pings unrelated to anything else each form their own topic.

This is one person's reading. There was no second labeller, so label noise is not measured; topic boundaries in a
continuous chat are partly a matter of judgement (for example whether a question about a ticket raised elsewhere starts
a new topic), and different rules would move the numbers by several points.

## Method

- Each data set is replayed in time order. For every routed message the router sees the topics in the same scope that
  were active in the last 24 hours (the idle-archive time); the expected answer is the message's labelled topic if that
  topic is among them, otherwise a new topic.
- After each decision the message is placed into its labelled topic (as if the owner corrected a mistake), so errors do
  not cascade and each decision is counted on its own.
- Messages addressed to a ticket and card buttons are not routed in the hub and are not counted, but they stay in their
  topics' history. The same routers counted over all 225 test messages are in the last section of the tool's output.
- The first 60 % of each data set (by time) is the train part, the rest the test part. All constants are chosen on the
  pooled train part by minimising 2 × wrong joins + wrong splits (a wrong join is counted twice as bad, since it pollutes
  a topic; 3× and 4× in "At the same wrong-join rate"), and every number below comes from the test part unless it says otherwise.
- Constants searched: rule a on reply text or question cards only, idle ≤ 30 min, 2 h or 24 h; rule e on or off; rule b
  length ≤ 4, 8, 12 or 20 and idle ≤ 10 min, 30 min or 2 h; for the score, hard windows of 30 min to 24 h or a decay of
  0.25–2 standard deviations of the score per doubling of idle time, 29 absolute thresholds (score quantiles) and margins
  of 0–1 standard deviation; topic text from owner messages only or with replies.
- The models run in Node 24 through `@huggingface/transformers` 4.3.2 on `onnxruntime-node`: `Xenova/multilingual-e5-small`
  (fp32, mean pooling, `query: ` prefix), `Xenova/bge-small-zh-v1.5` (fp32, CLS pooling), `Xenova/bge-m3` (q8, CLS pooling),
  all normalised and compared by dot product. Model2Vec was skipped.

## Results

### Rules without a score

| Router | Right | Wrong joins | Wrong splits | Error, 95 % |
|---|---|---|---|---|
| Always new (today) | 21.4 % | 0 | 121 (78.6 %) | 71–84 % |
| Most recent topic if active ≤ 10 min | 64.3 % | 49 (31.8 %) | 6 (3.9 %) | 29–44 % |
| Rule a only | 28.6 % | 4 (2.6 %) | 106 (68.8 %) | 64–78 % |
| Rule b only | 42.9 % | 9 (5.8 %) | 79 (51.3 %) | 49–65 % |
| Rule e only | 29.9 % | 3 (1.9 %) | 105 (68.2 %) | 62–77 % |
| Rules a + b | 42.2 % | 9 (5.8 %) | 80 (51.9 %) | 50–65 % |
| Rules a + e + b | 48.1 % | 11 (7.1 %) | 69 (44.8 %) | 44–60 % |

Rules a and b alone roughly halve today's wrong splits at a cost of 6 % wrong joins. Recency alone joins most messages
correctly but makes a wrong join of every third message.

### With a score (rules tuned together with the score)

| Scorer | Right | Wrong joins | Wrong splits | Error, 95 % | Cost | First Super-agent (136) right / joins / splits | Super-agent2 (18) right / joins / splits | Train part right |
|---|---|---|---|---|---|---|---|---|
| Bigram | 69.5 % | 20 (13.0 %) | 27 (17.5 %) | 24–38 % | 67 | 69.1 % / 20 / 22 | 72.2 % / 0 / 5 | 69.2 % |
| multilingual-e5-small | 62.3 % | 19 (12.3 %) | 39 (25.3 %) | 30–46 % | 77 | 63.2 % / 14 / 36 | 55.6 % / 5 / 3 | 73.1 % |
| bge-small-zh-v1.5 | 67.5 % | 13 (8.4 %) | 37 (24.0 %) | 26–40 % | 63 | 66.2 % / 13 / 33 | 77.8 % / 0 / 4 | 71.8 % |
| bge-m3 | 69.5 % | 19 (12.3 %) | 28 (18.2 %) | 24–38 % | 66 | 69.9 % / 17 / 24 | 66.7 % / 2 / 4 | 71.8 % |

Paired bootstrap of the cost difference (10 000 resamples of the 154 test messages): every scorer beats rules a + e + b
(bigram −38 to −10, bge-small-zh −38 to −18, bge-m3 −42 to −8, e5-small −33 to +5); none differs from bigram (e5-small
−6 to +26, bge-small-zh −16 to +7, bge-m3 −17 to +15).

Chosen constants per scorer (decay per doubling of idle time beyond 10 min; T absolute threshold; M margin):

| Scorer | Rules | T | M | Decay |
|---|---|---|---|---|
| Bigram | a (text, 30 min), e, b (≤ 12, 30 min) | 0.055 | 0.023 | 0.182 |
| multilingual-e5-small | a (cards only, 30 min), b (≤ 12, 30 min) | 0.886 | 0.013 | 0.0065 |
| bge-small-zh-v1.5 | a (text, 30 min), e, b (≤ 12, 30 min) | 0.570 | 0.096 | 0.048 |
| bge-m3 | a (text, 30 min), b (≤ 12, 30 min) | 0.573 | 0.042 | 0.042 |

### At the same wrong-join rate

At the constants chosen with wrong joins counted twice, `bge-small-zh-v1.5` made 13 wrong joins and 37 wrong splits,
bigram 20 and 27: two different operating points. To compare the scorers at the same wrong-join rate:

**Moving only the threshold, on the test part.** Rules a, e and b, the decay and the margin stay as chosen for each
scorer; each cell is the fewest wrong splits reachable with at most that many wrong joins of 154 (actual wrong joins in
brackets). The floor is the rules alone (threshold at infinity).

| Wrong joins at most | Bigram | bge-small-zh-v1.5 | bge-m3 |
|---|---|---|---|
| Floor (rules only) | 69 (11) | 69 (11) | 80 (9) |
| 10 | not reachable | not reachable | 70 (10) |
| 12 | 57 (12) | 64 (12) | 53 (12) |
| 13 | 57 (13) | 36 (13) | 53 (13) |
| 15 | 51 (15) | 34 (15) | 39 (15) |
| 17 | 41 (17) | 34 (17) | 35 (17) |
| 18 | 32 (18) | 34 (18) | 31 (18) |
| 20 | 26 (20) | 34 (18) | 27 (20) |
| 22 | 25 (22) | 34 (18) | 26 (22) |

Wrong joins by rule at about 13 wrong joins: bigram a 4, e 3, b 4, score 2; bge-small-zh a 4, e 3, b 4, score 2; bge-m3
(which was chosen without rule e) a 4, b 5, score 4. About 10 and 7 wrong joins are below the floor of rules a + e + b
(11 wrong joins: a 4, e 3, b 4): no threshold reaches them, because the score can only remove its own wrong joins.

The same curve on the train part, where the constants were chosen (234 messages):

| Wrong joins at most | Bigram | bge-small-zh-v1.5 | bge-m3 |
|---|---|---|---|
| 15 | 90 (15) | 91 (15) | 88 (15) |
| 17 | 80 (17) | 90 (17) | 75 (17) |
| 19 | 79 (19) | 79 (19) | 62 (19) |
| 21 | 74 (21) | 65 (21) | 56 (21) |
| 23 | 63 (23) | 50 (23) | 52 (22) |
| 25 | 61 (25) | 50 (25) | 49 (25) |
| 27 | 53 (27) | 39 (27) | 45 (27) |
| 29 | 43 (29) | 39 (29) | 36 (29) |

**Constants chosen on the train part with wrong joins weighted 3× and 4×,** measured on the test part (weights 3 and 4
choose the same constants for bigram and bge-small-zh):

| Scorer | Weight | Right | Wrong joins | Wrong splits | Error, 95 % | Rules chosen | Wrong joins by rule |
|---|---|---|---|---|---|---|---|
| Bigram | 3 and 4 | 61.7 % | 11 (7.1 %) | 48 (31.2 %) | 31–46 % | b ≤ 12, 30 min; T 0.055, M 0.091, decay 0.18 | b 6, score 5 |
| bge-small-zh-v1.5 | 3 and 4 | 60.4 % | 10 (6.5 %) | 51 (33.1 %) | 32–47 % | b ≤ 12, 10 min; T 0.600, M 0.096, decay 0.19 | b 6, score 4 |
| bge-m3 | 3 | 53.9 % | 14 (9.1 %) | 57 (37.0 %) | 38–54 % | a, b ≤ 12, 30 min; window 2 h | a 4, b 5, score 5 |
| bge-m3 | 4 | 55.2 % | 12 (7.8 %) | 57 (37.0 %) | 37–53 % | b ≤ 12, 10 min; decay | b 6, score 6 |

**Paired bootstrap, bge-small-zh minus bigram** (10 000 resamples of the 154 test messages; negative favours
bge-small-zh):

| Comparison | bge-small-zh | Bigram | Difference, 95 % | bge-small-zh better in |
|---|---|---|---|---|
| Wrong joins, constants chosen with weight 2 | 13 | 20 | −13 to −1 | 99 % |
| Wrong splits, constants chosen with weight 2 | 37 | 27 | +2 to +19 | 1 % |
| Wrong joins, constants chosen with weight 3 or 4 | 10 | 11 | −4 to +2 | 61 % |
| Wrong splits, constants chosen with weight 3 or 4 | 51 | 48 | −7 to +13 | 24 % |
| Wrong splits at most 13 wrong joins (threshold picked on the test part) | 36 | 57 | −31 to −12 | 100 % |

**What this says.** On the test part, with the rules kept and only the threshold moved, bge-small-zh leaves clearly
fewer wrong splits than bigram between 13 and 17 wrong joins (36 against 57 at 13). That point is picked on the test
messages, and the advantage does not hold elsewhere: on the test part bigram is level or better from 18 wrong joins up,
and on the train part bigram is level or better up to 19 wrong joins, the low-join end that matters here. When the
constants are chosen on the train part with wrong joins weighted 3× or 4× and then measured on the test part, both
scorers land on the same point (10–11 wrong joins, 48–51 wrong splits) and the bootstrap intervals contain zero. A
stricter bigram threshold alone does not get there: with rules a and e kept, bigram needs 57 wrong splits for 13 wrong
joins. What gets there is dropping rules a and e (7 of the 11 wrong joins at the floor) and raising the margin. So at an
equal wrong-join rate, bge-small-zh does not leave fewer wrong splits than bigram in a way these data can confirm. The
recommended scorer stays bigram; the recommended constants change to the weight-3 ones, because of the owner's
preference for fewer wrong joins.

### What each rule contributes (test part, router with wrong joins counted twice)

| Rule | Decisions | Right | Wrong joins | Wrong splits |
|---|---|---|---|---|
| a, open question | 17 | 13 | 4 | 0 |
| e, reference | 15 | 12 | 3 | 0 |
| b, short reply | 22 | 18 | 4 | 0 |
| c, score | 45 | 36 | 9 | 0 |
| d, new topic | 55 | 28 | 0 | 27 |

Without rules a, e and b the score alone reaches 50–57 % (bigram 55.2 %); the rules add 6–18 points on top of the
score, 14 for bigram. Rule e (not in the issue's sketch) adds about 6 points to the rules alone and 0.7 to the bigram router; it is
cheap and its joins were right 12 times in 15.

### Separation

| Scorer | Pair AUC (same vs different topic, ≤ 24 h apart) | Pair AUC, later message ≤ 10 characters | Message vs topic AUC | True topic ranked first | … for messages ≤ 10 characters |
|---|---|---|---|---|---|
| Most recent topic | — | — | — | 78.4 % | 81.1 % |
| Bigram | 0.595 | 0.526 | 0.765 | 45.6 % | 41.5 % |
| multilingual-e5-small | 0.622 | 0.553 | 0.742 | 53.3 % | 22.6 % |
| bge-small-zh-v1.5 | 0.595 | 0.552 | 0.747 | 53.7 % | 26.4 % |
| bge-m3 | 0.648 | 0.520 | 0.776 | 49.5 % | 18.9 % |

Pairs: 2 712 same-topic and 23 925 different-topic pairs from both data sets, all owner messages. Message against topic:
the 287 routed messages whose topic was active alongside at least one other; the topic text includes replies.

No scorer separates topics well on its own: pair AUCs are 0.60–0.65 and close to chance for short messages. The score is
useful as a second opinion after recency: it decides whether a message continues an active topic at all, and it moves a
message away from the most recent topic when another topic matches clearly better. Both need the time decay. Topic text
with the replies included was better than owner messages only for every scorer.

### Absolute threshold, margin, window, decay (test part)

| Scorer | Threshold + margin + decay (chosen) | Threshold, no margin | Margin, no threshold | Hard window instead of decay |
|---|---|---|---|---|
| Bigram | 69.5 % | 70.8 % | 57.8 % | 63.0 % |
| multilingual-e5-small | 62.3 % | 68.8 % | 61.0 % | 55.8 % |
| bge-small-zh-v1.5 | 67.5 % | 66.9 % | 62.3 % | 62.3 % |
| bge-m3 | 69.5 % | 65.6 % | 60.4 % | 53.9 % |

### Short messages

The test part has 26 routed messages of at most 10 characters. Every router with rule b gets 20 of them right and makes
6 wrong joins; the score changes none of these outcomes. A short message
that answers an older topic while a newer one is active is the remaining error here, and no signal in these data
recovers it.

### Time per decision

Reported, not asserted. One message embedded on its own, as the hub would; the replies' vectors would be computed once
when they are written. The bigram score needs no model and takes well under a millisecond.

| Scorer | This PC: load | This PC: median / p95 per message | NAS: load | NAS: median / p95 per message |
|---|---|---|---|---|
| Bigram | — | < 0.1 ms | — | not measured (no model) |
| multilingual-e5-small (fp32) | 0.9 s | 4.4 / 13.0 ms | 8.5 s | 97 / 167 ms |
| multilingual-e5-small (q8) | — | — | 18.2 s | 63 / 108 ms |
| bge-small-zh-v1.5 (fp32) | 0.1 s | 2.2 / 7.2 ms | 1.6 s | 41 / 67 ms |
| bge-m3 (q8) | 1.2 s | 14.3 / 41.7 ms | 11.0 s | 689 / 955 ms |

PC loads are from the local model cache. NAS figures come from a one-off container on synthetic sentences (no chat
text); it started with an empty cache, so its load times include downloading the model files. The resident memory of
the probe process grew to 1.0–1.3 GB with the models loaded one after another in it.

### The NAS

The NAS (QNAP, Intel Celeron N5095, 4 cores, 16 GB) is **x86_64**. `onnxruntime-node` 1.30.0, the version
`@huggingface/transformers` 4.3.2 pins, ships prebuilt binaries for `linux/x64` (and `linux/arm64`) inside its npm
package. A one-off container from the hub's image (`superagent2-hub:current`, built `FROM node:24.14.1-bookworm-slim`),
started separately with no volumes and removed afterwards, installed the package and loaded all three models. The
package's install script only downloads CUDA libraries and is not needed; this repository's `pnpm-workspace.yaml` denies
it (and protobufjs's) under `allowBuilds`.

## Running it again

The tool is `tools/route-eval`. It reads copies of the two databases and a label file and writes the report and the
per-message listings to a folder that must lie outside the repository:

```sh
pnpm --filter @super-agent2/route-eval build
node tools/route-eval/dist/cli.js --superagent <first hub.sqlite> --superagent2 <hub.sqlite> --labels <labels.json> --models <model cache> --out <folder outside the repository>
```

The bigram representation, the reference extraction, the rules and the model scorer are those of `packages/routing`,
which the hub routes with (#143); the section "Shipped configurations" of the output measures the hub's two
configurations with their constants.

`--scorers bigram,e5-small,bge-small-zh,bge-m3` picks the scorers (default all), `--train 0.6` the train share and
`--short 10` the short-message limit for reporting. The label file maps each data set's name (`super-agent`,
`super-agent2`) to an object from message id to topic name.
