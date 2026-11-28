# Demo opt-in — fixture-backed visual evidence

Before: `b8a7cd195`; after: `2da695702e09a1ec712162ab47aaf7ae2f9d2c24`. Running local Next builds, fixed synthetic API fixtures, Chrome, light/dark themes. These captures prove layout and interaction presentation only. The real Postgres-backed consent/revocation test is reported separately in the PR. Production content and deployment were not tested.

The new `/demo` page has no corresponding page on main. Before/after pairs cover existing tracing/onboarding entry surfaces and the Detector list/panel. Detector fixtures model the API's before/after projection (the same sample becomes a public template with redacted model/sampling values). Local command examples use port 3110 before and 3109 after. Browser dev indicators are hidden only in the capture harness.

## Checks

| Check | Result |
|---|---|
| Before/after pages, light/dark, 1440×900 | Captured with pixel diffs |
| New Join/Open/Leave/error states | Captured |
| Widths 1024, 768, 390 | 33 checks, all 0 px document overflow |
| Mobile navigation drawer | Captured at 390 px |
| Browser page errors / unknown API fixture routes | None |
| Videos | Before/after, 1280×720, each below 30 seconds |

| Pair | Light | Dark | Target |
|---|---:|---:|---:|
| foreground on background | 19.19:1 | 17.18:1 | 4.5:1 |
| card-foreground on card | 19.19:1 | 16.51:1 | 4.5:1 |
| muted-foreground on card | 6.70:1 | 7.70:1 | 4.5:1 |
| primary-ink on primary | 7.78:1 | 7.78:1 | 4.5:1 |
| danger on card | 7.51:1 | 6.57:1 | 4.5:1 |
| ring on card | 5.04:1 | 7.44:1 | 3:1 |

## Videos

[Before](before.webm) · [After](after.webm)

**Before:** 0.0s trace-entry, 1.7s onboarding-entry, 3.3s detector-list, 5.0s detector-panel.

**After:** 0.0s trace-entry, 1.6s onboarding-entry, 3.2s demo-join, 4.8s demo-joined, 7.1s detector-list, 8.8s detector-panel, 10.5s leave-demo.

## Before and after

### trace-entry, light

| Before | After | Diff |
|---|---|---|
| ![before](before-trace-entry-light.png) | ![after](after-trace-entry-light.png) | ![diff](diff-trace-entry-light.png) |

### trace-entry, dark

| Before | After | Diff |
|---|---|---|
| ![before](before-trace-entry-dark.png) | ![after](after-trace-entry-dark.png) | ![diff](diff-trace-entry-dark.png) |

### onboarding-entry, light

| Before | After | Diff |
|---|---|---|
| ![before](before-onboarding-entry-light.png) | ![after](after-onboarding-entry-light.png) | ![diff](diff-onboarding-entry-light.png) |

### onboarding-entry, dark

| Before | After | Diff |
|---|---|---|
| ![before](before-onboarding-entry-dark.png) | ![after](after-onboarding-entry-dark.png) | ![diff](diff-onboarding-entry-dark.png) |

### detector-list, light

| Before | After | Diff |
|---|---|---|
| ![before](before-detector-list-light.png) | ![after](after-detector-list-light.png) | ![diff](diff-detector-list-light.png) |

### detector-list, dark

| Before | After | Diff |
|---|---|---|
| ![before](before-detector-list-dark.png) | ![after](after-detector-list-dark.png) | ![diff](diff-detector-list-dark.png) |

### detector-panel, light

| Before | After | Diff |
|---|---|---|
| ![before](before-detector-panel-light.png) | ![after](after-detector-panel-light.png) | ![diff](diff-detector-panel-light.png) |

### detector-panel, dark

| Before | After | Diff |
|---|---|---|
| ![before](before-detector-panel-dark.png) | ![after](after-detector-panel-dark.png) | ![diff](diff-detector-panel-dark.png) |

## Explicit entry

### demo-join

| Light | Dark |
|---|---|
| ![Light](after-demo-join-light.png) | ![Dark](after-demo-join-dark.png) |

### demo-joined

| Light | Dark |
|---|---|
| ![Light](after-demo-joined-light.png) | ![Dark](after-demo-joined-dark.png) |

### demo-error

| Light | Dark |
|---|---|
| ![Light](after-demo-error-light.png) | ![Dark](after-demo-error-dark.png) |

## Narrow viewports

### trace-entry

| 1024 | 768 | 390 |
|---|---|---|
| ![1024](after-trace-entry-1024.png) | ![768](after-trace-entry-768.png) | ![390](after-trace-entry-390.png) |

![Navigation drawer](after-trace-entry-390-drawer.png)

### onboarding-entry

| 1024 | 768 | 390 |
|---|---|---|
| ![1024](after-onboarding-entry-1024.png) | ![768](after-onboarding-entry-768.png) | ![390](after-onboarding-entry-390.png) |

### detector-list

| 1024 | 768 | 390 |
|---|---|---|
| ![1024](after-detector-list-1024.png) | ![768](after-detector-list-768.png) | ![390](after-detector-list-390.png) |

![Navigation drawer](after-detector-list-390-drawer.png)

### detector-panel

| 1024 | 768 | 390 |
|---|---|---|
| ![1024](after-detector-panel-1024.png) | ![768](after-detector-panel-768.png) | ![390](after-detector-panel-390.png) |

![Navigation drawer](after-detector-panel-390-drawer.png)

### demo-join

| 1024 | 768 | 390 |
|---|---|---|
| ![1024](after-demo-join-1024.png) | ![768](after-demo-join-768.png) | ![390](after-demo-join-390.png) |

![Navigation drawer](after-demo-join-390-drawer.png)

### demo-joined

| 1024 | 768 | 390 |
|---|---|---|
| ![1024](after-demo-joined-1024.png) | ![768](after-demo-joined-768.png) | ![390](after-demo-joined-390.png) |

![Navigation drawer](after-demo-joined-390-drawer.png)

### demo-error

| 1024 | 768 | 390 |
|---|---|---|
| ![1024](after-demo-error-1024.png) | ![768](after-demo-error-768.png) | ![390](after-demo-error-390.png) |

![Navigation drawer](after-demo-error-390-drawer.png)

[Overflow/console checks](checks.json) · [Changed pixel counts](pixel-diffs.json)
