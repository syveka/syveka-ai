# Voice add-on: unit economics of the provisional price

Written for the owner, 2026-11-05. **The price of €39 for 100 minutes and €0.25 per extra minute is a hypothesis. It isn't published or active, and this review doesn't validate it.** It can't, until real calls exist: every call cost here is an estimate.

## Result

- **On call costs alone, the hypothesis looks healthy:** about 78% at full use with tenant-owned numbers.
- **Support time decides it.** With 20 customers sharing the Vapi plan, that falls to about 46% at 15 minutes of support a month, and about 17% at 30 minutes. No support data exists.
- **Below about 20 customers, the shared Vapi plan matters too.**
- **Recommendation:** don't validate or reject the price yet. Measure real cost per minute and real support time in the pilot, then decide against the thresholds below.

## Assumptions

| Item                     | Value                                     | Basis                                                                                                                 |
| ------------------------ | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Exchange rate            | EUR 1 = USD 1.10                          | **Assumption**                                                                                                        |
| Call cost, tenant-owned  | $0.0776 a minute                          | **Estimate:** `pricing-and-profitability.md` on #399. Vapi, Deepgram, Azure and Haiku 4.5                             |
| Call cost, Syveka-owned  | $0.0883 a minute, plus a $6.60 number     | **Estimate.** For comparison only, since the pilot uses tenant-owned numbers                                          |
| Post-call summary        | $0.003 per call, one call per 3 minutes   | **Estimate:** Haiku 4.5, about 2,000 input and 200 output tokens                                                      |
| Stripe card fee          | 1.5% + €0.25                              | [Stripe](https://stripe.com/en-fi/pricing), standard EEA cards. Premium cards cost 2.8%, UK 2.5%, international 3.15% |
| Stripe Billing           | 0.7% of billing volume                    | [Stripe](https://stripe.com/en-fi/pricing), pay as you go                                                             |
| VAT on the charged total | 25.5%                                     | **Assumption** for a Finnish customer: fees apply to the amount charged. Confirm with an accountant                   |
| Vapi plan                | $29 a month, 10 lines, $10 per extra line | [Vapi](https://vapi.ai/pricing). Which plan Syveka holds isn't known                                                  |
| Peak concurrent lines    | One third of customers                    | **Assumption**                                                                                                        |
| Support                  | $50 an hour                               | **Assumption**                                                                                                        |

## One customer, one month, by use

Includes call cost, summaries and Stripe's fee of about $1.46. Excludes support and shared costs. Revenue is $42.90, excluding VAT.

| Minutes used | Tenant-owned number | Syveka-owned number | Tenant-owned at $0.12 a minute |
| ------------ | ------------------- | ------------------- | ------------------------------ |
| 25           | $3.42, 92%          | $10.29, 76%         | $4.48, 90%                     |
| 50           | $5.39, 87%          | $12.52, 71%         | $7.51, 82%                     |
| 100          | $9.32, 78%          | $16.99, 60%         | $13.56, 68%                    |

The last column tests a real cost about 55% above the estimate.

## Full use, with shared cost and support

Tenant-owned number, 100 minutes used.

| Customers | Lines at peak | Shared cost each | No support | 15 min a month | 30 min a month |
| --------- | ------------- | ---------------- | ---------- | -------------- | -------------- |
| 5         | 2             | $5.80            | 65%        | 36%            | 6%             |
| 20        | 7             | $1.45            | 75%        | 46%            | 17%            |
| 100       | 34            | $2.69            | 72%        | 43%            | 14%            |

At 100 customers the table assumes Vapi Core plus 24 extra lines, at $269 a month. Vapi's Pro plan starts at $999 a month and may be needed for other reasons, such as its limit of 5 numbers on Core, whose treatment of imported numbers isn't known. At $999 a month, the shared cost is about $10 per customer, which takes about 17 percentage points off this row.

**Price needed at full use, with 20 customers and 15 minutes of support:** about €43 for a 50% margin, €54 for 60%, and €74 for 70%.

## Extra minutes at €0.25

Revenue is $0.275 a minute, with about $0.008 in fees. Summaries add about $0.001, which takes the stress case to about 53%.

| Call cost per minute  | Margin |
| --------------------- | ------ |
| $0.0776, tenant-owned | 69%    |
| $0.0883, Syveka-owned | 65%    |
| $0.12, stress case    | 54%    |

## What this still leaves out

- **Fixed compliance cost:** counsel, DPAs, a possible Vapi EU plan. If EU hosting requires Vapi's Premier package, its custom price could change this review on its own.
- **Base plan interaction:** whether the add-on stacks with AI messages, which can lose money for one-seat Pro at full use (#399).
- **Failed payments and refunds:** at full use, a refunded month costs about $9 in direct cost, and a failed payment about $8, since no card fee applies.
- **Who pays Twilio:** tenant-owned means the tenant pays about $0.0107 a minute plus a number. That's a real cost to them, and may affect what they'll pay.
- **Annual discounts**, and the Stripe premium-card mix.
- **Competitor pricing and willingness to pay.** Nothing here tests demand.

## Before activating any price

| Gate | Threshold, proposed for the owner to confirm |
| ----------------------------------------------------------------------- | ---------------------------------------------------------- || Real cost per minute, from `costCents`, over at least 100 pilot minutes | Measured. $0.12 is a stress case, not a target: with 15 minutes of support, it gives about 36% || Real support time per customer, over at least 2 pilot months | Measured. At €39, 15 minutes gives about 46% at full use, below the likely target, so it will likely need less support or a higher price || Margin at full use, including support and shared costs | At or above the owner's target. 50–60% is the likely range |
| Metering verified against Vapi's own records | No unexplained differences over the pilot |
| Legal: terms, overage consent, VAT treatment | Approved |
| Vapi plan, number and line limits | Confirmed in writing |

## Decision needed

The owner's target gross margin, and who measures support time during the pilot.
