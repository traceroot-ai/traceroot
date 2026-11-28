# Demo opt-in — fixture-backed visual evidence

Before: `b8a7cd195`; after: `286ca0e3b`. Running local Next builds, fixed synthetic API fixtures, light/dark themes and Chrome. These captures prove layout and interaction presentation only. The real database-backed consent/revocation test is reported separately in the PR; production content and deployment were not tested.

The new `/demo` page has no pre-existing page to compare on main. Existing tracing/onboarding entry pages retain their layout and now point to the explicit entry page. Local command examples use port 3110 before and 3109 after.

## Criteria and results

| Check | Result |
|---|---|
| Existing entry surfaces, light/dark, 1440×900 | Captured before/after and pixel diffs |
| New Join/Open/Leave/error page, light/dark | Captured |
| Widths 1024, 768, 390 | 0 px document overflow in all 21 checks |
| Mobile navigation drawer | Captured at 390 px |
| Browser page errors / unknown API fixture routes | None |
| Video | Before and after, 1280×720, each below 30 seconds |

| Pair | Light | Dark | Target |
|---|---:|---:|---:|
| foreground on background | 19.19:1 | 17.18:1 | 4.5:1 |
| card-foreground on card | 19.19:1 | 16.51:1 | 4.5:1 |
| muted-foreground on card | 6.70:1 | 7.70:1 | 4.5:1 |
| primary-ink on primary | 7.78:1 | 7.78:1 | 4.5:1 |
| danger on card | 7.51:1 | 6.57:1 | 4.5:1 |
| ring on card | 5.04:1 | 7.44:1 | 3:1 |

## Videos

[Before video](before.webm) · [After video](after.webm)

**Before chapters:** 0.0s trace-entry, 1.6s onboarding-entry.

**After chapters:** 0.0s trace-entry, 1.7s onboarding-entry, 3.3s demo-join, 4.8s demo-joined, 7.2s leave-demo.

## Existing entry surfaces

### trace-entry, light

| Before | After | Pixel diff |
|---|---|---|
| ![before](before-trace-entry-light.png) | ![after](after-trace-entry-light.png) | ![diff](diff-trace-entry-light.png) |

### trace-entry, dark

| Before | After | Pixel diff |
|---|---|---|
| ![before](before-trace-entry-dark.png) | ![after](after-trace-entry-dark.png) | ![diff](diff-trace-entry-dark.png) |

### onboarding-entry, light

| Before | After | Pixel diff |
|---|---|---|
| ![before](before-onboarding-entry-light.png) | ![after](after-onboarding-entry-light.png) | ![diff](diff-onboarding-entry-light.png) |

### onboarding-entry, dark

| Before | After | Pixel diff |
|---|---|---|
| ![before](before-onboarding-entry-dark.png) | ![after](after-onboarding-entry-dark.png) | ![diff](diff-onboarding-entry-dark.png) |

## New explicit entry page

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

![390px navigation](after-trace-entry-390-drawer.png)

### onboarding-entry

| 1024 | 768 | 390 |
|---|---|---|
| ![1024](after-onboarding-entry-1024.png) | ![768](after-onboarding-entry-768.png) | ![390](after-onboarding-entry-390.png) |

### demo-join

| 1024 | 768 | 390 |
|---|---|---|
| ![1024](after-demo-join-1024.png) | ![768](after-demo-join-768.png) | ![390](after-demo-join-390.png) |

![390px navigation](after-demo-join-390-drawer.png)

### demo-joined

| 1024 | 768 | 390 |
|---|---|---|
| ![1024](after-demo-joined-1024.png) | ![768](after-demo-joined-768.png) | ![390](after-demo-joined-390.png) |

![390px navigation](after-demo-joined-390-drawer.png)

### demo-error

| 1024 | 768 | 390 |
|---|---|---|
| ![1024](after-demo-error-1024.png) | ![768](after-demo-error-768.png) | ![390](after-demo-error-390.png) |

![390px navigation](after-demo-error-390-drawer.png)

[Machine-readable overflow/console checks](checks.json) · [Changed pixel counts](pixel-diffs.json)
