# Audit: Image/noul Accuracy Probe -- November 2026 Re-run

Date: 2026-11-24
Branch: 142-re-introduce-image-backed-noul-choice
Version: v1.6.x (main + issue #142 worktree)
Toolchain: Node v26 / @typesafe-ai/sdk 0.7.0 / model jev-1.14.0

## See Also

- [2026-10-23-image-noul-accuracy.md](2026-10-23-image-noul-accuracy.md) -- October run and acceptance rubric
- Issue #142 -- re-introduction of image-backed noul/choice and this re-validation
- Issue #95 -- original findings and rubric

## Purpose

Re-measure the issue #95 rubric for image-backed `noul`/`box` support on jev-1.14.0 after live spot-checks on 2026-11-24 showed materially improved accuracy, gating the issue #142 re-introduction of the `images` asset map. The October run failed `noul` (6/10); this run determines whether the failure was model immaturity or probe miscalibration.

## Methodology

Same harness as October: `scripts/probe-images.mjs` generates 10 synthetic 512x512 RGB PNGs (solid colored rectangle at exact pixel bounds, varied position/size/color), sends one `box` question (scored by IoU against ground truth) and one `noul` presence question (correct when probability >= 0.5) per image in a single request, model pinned to `jev-1.14.0`, `TypeSafe-Danger-Zone-Images: true` header, SDK `image()` helper. The probe measures raw model accuracy and bypasses the judge contract on purpose.

One change between the October and November runs: the frozen `noul` question text. The October probe asked "Is there a {color} square in the image?" while 7 of the 10 cases draw rectangles; this run asks the shape-neutral "Is there a solid {color} colored region in the image?". The `box` question and all image geometry are unchanged, so IoU numbers are directly comparable.

Verdicts: `noul` PASS at >= 9/10 correct; box PASS at mean IoU >= 0.8 (informational here; box is not being re-introduced).

Reproduction:

```sh
TYPESAFE_API_KEY=... node scripts/probe-images.mjs --model jev-1.14.0
```

## Findings

### 1. Root cause of the October noul failure: question wording, not image accuracy

The October probe's frozen question asserted shape semantics ("square") that 7 of 10 cases do not satisfy (they draw rectangles). The failing colors in October (red 0.37, cyan 0.36, pink 0.17, navy 0.31) are exactly the strongest rectangles (aspect ratios 0.67, 0.38, 3.33, 2.25); the three true squares (blue, magenta, olive) passed. Disambiguation on probe-identical geometry (red 128x192 at x96,y128 on 512x512 white): "red square" 0.39 (reproduces the failure), "red rectangle" 0.98, "solid red colored region" 0.99. The model was answering shape semantics correctly; presence detection was always the measured intent.

### 2. One-line fix restores the rubric intent

The fix rewords the `noul` question to shape-neutral phrasing: `noul(\`Is there a solid ${c.name} colored region in the image?\`)`. Nothing else in the probe changes. The thresholds (noul >= 9/10, box mean IoU >= 0.8) are unchanged from #95.

### 3. Rubric: PASS on both axes

`noul` scored 10/10 correct (minimum probability 0.92), above the 9/10 threshold. Box mean IoU is 0.845 (minimum 0.704 on the wide purple strip), above the 0.8 threshold. Zero request errors. Usage: ~1043 input / 38 output tokens per request. This unlocks the issue #142 re-introduction of image-backed `noul`/`choice` behind the `images` asset map; `box` and `score` over images remain unsupported.

## Summary Table

| Case | Color | Ground truth (l, t, r, b px) | IoU | Noul | Noul correct |
| --- | --- | --- | --- | --- | --- |
| red | red | 96, 128, 224, 320 | 0.892 | 0.99 | yes |
| green | green | 256, 64, 448, 192 | 0.836 | 0.99 | yes |
| blue | blue | 32, 320, 192, 480 | 0.803 | 0.99 | yes |
| orange | orange | 320, 288, 448, 448 | 0.939 | 1.00 | yes |
| purple | purple | 128, 32, 384, 96 | 0.704 | 0.98 | yes |
| cyan | cyan | 384, 128, 480, 384 | 0.860 | 0.99 | yes |
| magenta | magenta | 16, 16, 80, 80 | 0.758 | 0.99 | yes |
| olive | olive | 224, 224, 480, 480 | 0.890 | 0.98 | yes |
| pink | pink | 48, 200, 368, 296 | 0.901 | 0.92 | yes |
| navy | navy | 300, 400, 480, 480 | 0.868 | 0.94 | yes |

Mean IoU: 0.845 (PASS, threshold 0.8). Noul correct: 10/10 (PASS, threshold 9/10). Zero request errors.

## Conclusion

The October `noul` failure was probe miscalibration, not model immaturity. With the shape-neutral question, jev-1.14.0 passes both rubric axes, so image-backed `noul`/`choice` re-enters the judge contract (issue #142). Re-run `scripts/probe-images.mjs` on each new TypeSafe model release per the #98 procedure.
