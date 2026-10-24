# Audit: Image/noul Accuracy Probe -- October 2026

Date: 2026-10-23  
Branch: feat/issue-95-image-probe-rubric  
Version: v1.6.1 (main 208060f + probe harness)  
Toolchain: Node v26 / @typesafe-ai/sdk 0.7.0 / model jev-1.14.0

## See Also

- [2026-09-22-code-review.md](2026-09-22-code-review.md) -- full code review of v1.3.0
- Issue #95 -- findings and acceptance rubric for image-backed questions

## Purpose

Evaluate the issue #95 acceptance rubric for image-backed `noul`/`choice`/`score` support using a reproducible probe harness (`scripts/probe-images.mjs`): 10 synthetic ground-truth PNGs (solid square on white background, varied position/size/color), one request per image carrying a `box` question (scored by IoU against ground truth) and a `noul` question (correct when probability >= 0.5 for the unambiguous yes).

## Methodology

Each case is a 512x512 RGB PNG generated in-process (zlib-deflated, no image dependencies) with a solid colored square at exact pixel bounds; ground-truth fractions are `px / 512`. One `client.systemOne` call per image with the `TypeSafe-Danger-Zone-Images: true` header, model pinned to `jev-1.14.0`, state carrying the image via the SDK `image()` helper. IoU is computed against the returned `box` fractions. The probe bypasses the server's `validateImages` guard on purpose: it measures raw model accuracy, not the shipped judge contract.

Verdicts:

- **PASS**: rubric threshold met across all 10 cases.
- **FAIL**: rubric threshold not met.

Reproduction:

```sh
TYPESAFE_API_KEY=... node scripts/probe-images.mjs
```

## Findings

### 1. Box localization rubric: PASS (mean IoU 0.857 >= 0.8)

Mean IoU across 10 cases is 0.857 with a minimum of 0.716 (`purple`, a wide 256x64 strip). 9/10 cases score >= 0.78. Consistent with the single-image probe from #94 (IoU 0.860). `box` support with images remains sound.

### 2. Noul-on-image rubric: FAIL (6/10 correct, needs >= 9)

The model answered the unambiguous yes with probability >= 0.5 on only 6 of 10 cases, failing confidently on four (red 0.37, cyan 0.36, pink 0.17, navy 0.31). Failure correlates with no obvious single factor (position, size, and color of failures are not clustered), consistent with image-conditioned noul being immature on this model release. This confirms the issue #95 live-probe finding (0.03-0.05 probability on 3/3 calls).

### 3. Judge contract unchanged

Per the issue #95 decision rule, `noul`/`choice`/`score` remain restricted to text state and the `images` map remains box-only input; the Cloudflare path continues to fail closed for images. No contract changes are unlocked.

## Summary Table

| Case | Color | Ground truth (l, t, r, b px) | IoU | Noul | Noul correct |
| --- | --- | --- | --- | --- | --- |
| red | red | 96, 128, 224, 320 | 0.914 | 0.37 | no |
| green | green | 256, 64, 448, 192 | 0.836 | 0.79 | yes |
| blue | blue | 32, 320, 192, 480 | 0.803 | 0.98 | yes |
| orange | orange | 320, 288, 448, 448 | 0.884 | 0.92 | yes |
| purple | purple | 128, 32, 384, 96 | 0.716 | 0.62 | yes |
| cyan | cyan | 384, 128, 480, 384 | 0.919 | 0.36 | no |
| magenta | magenta | 16, 16, 80, 80 | 0.780 | 0.96 | yes |
| olive | olive | 224, 224, 480, 480 | 0.907 | 0.94 | yes |
| pink | pink | 48, 200, 368, 296 | 0.905 | 0.17 | no |
| navy | navy | 300, 400, 480, 480 | 0.910 | 0.31 | no |

Mean IoU: 0.857 (PASS, threshold 0.8). Noul correct: 6/10 (FAIL, threshold 9/10). Zero request errors. Usage: 1041 input / 38 output tokens per request.

## Conclusion

Re-run `scripts/probe-images.mjs` on each new TypeSafe model release; image-backed `noul`/`choice`/`score` stays unsupported until the noul rubric (>= 9/10) passes alongside the box rubric (mean IoU >= 0.8).
