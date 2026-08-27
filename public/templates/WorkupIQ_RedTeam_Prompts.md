# WorkupIQ Red-Team Prompts

Upload the completed Investment Memo and Red-Team FAQ into Claude, ChatGPT, or WorkupIQ Screen. Run all four. If the model can still write a durable Pass reason, add a quantitative line to the memo or FAQ and re-run.

---

## 1. Gatekeeper Screener

```
Role: You are a cynical, overworked Principal at a Tier-1 venture fund reviewing inbound deal flow.
Context: You evaluate 50+ memos a week and look for reasons to pass within 3 minutes.
Task: Critically review the attached Investment Memo and FAQ.

Output the following strictly in markdown:
1. Fatal Flaw Checklist: Identify the top 3-5 immediate reasons to PASS on this deal (e.g., market sizing assumptions, AI commodity risk, regulatory hurdles, or weak unit economics).
2. Information Deficit: What critical data points are completely missing or vaguely defined?
3. Verdict: State clearly — Pass, Request More Data, or Advance to Partner Call, along with a 2-sentence rationale.
```

---

## 2. Defensibility & Wrapper Stress Test

```
Role: You are a Deep-Tech & AI Partner evaluating platform defensibility and structural moats.
Task: Attack the technical and defensibility claims in the attached document.

Execute the following stress tests:
1. Foundation Model Disruption: Explain why a frontier model lab or legacy enterprise could commoditize this solution with an in-house build or API update within 12 months.
2. Moat Evaluation: Critique the claimed proprietary data loop and IP. Is the moat genuine, or is it an illusion of complexity?
3. 5 Direct Interrogation Questions: Write the 5 hardest technical and architectural questions you would ask the CTO on a diligence call to break their narrative.
```

---

## 3. Financial & Unit Economics Forensic Audit

```
Role: You are a Quantitative Diligence Associate auditing financial projections and commercial traction.
Task: Scrutinize all numbers, TAM/SAM/SOM calculations, and unit economics in the attached text.

Evaluate:
1. Math & Sizing Sanity Check: Identify any non-sequiturs or aggressive bottom-up TAM assumptions.
2. Burn vs. Runway Sensitivity: Calculate if the capital ask is realistically sufficient for the stated 18-24 month milestone targets given the operational scope.
3. CAC & Payback Vulnerability: Challenge the stated CAC payback period and sales cycle against standard enterprise B2B benchmarks.
```

---

## 4. Partner Meeting Pre-Mortem

```
Role: You are the Investment Committee simulating a 3-year Pre-Mortem failure analysis.
Premise: Assume we funded this company today, but the company goes to zero or requires a down-round recapitalization in 24 months.

Identify:
1. The Primary Cause of Failure: The single most probable operational, technical, or go-to-market failure mode.
2. Underestimated External Friction: Specific customer procurement, switching-cost, or regulatory delays that the founders brushed aside.
3. Recommended Revisions: Exactly what needs to be added or clarified in the memo right now to eliminate these specific concerns before presenting to the IC.
```
