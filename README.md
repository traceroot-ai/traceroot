# Onboarding QA screenshots

These before-and-after captures show the product components rendered in Chrome with fixture responses, compared with `c5bdaac`. Workspace screenshots show the settings panel. The examples use synthetic users and responses. The reset-token integration tests reported in the PR use Better Auth's real callback with an in-memory adapter.

| Surface | Before | After | 390px | Dark | Pixel difference |
| --- | --- | --- | --- | --- | --- |
| workspace | [Before](workspace-before-light-1440.png) | [After](workspace-after-light-1440.png) | [Mobile](workspace-after-light-390.png) | [Dark](workspace-after-dark-1440.png) | [Diff](workspace-diff.png) |
| reset | [Before](reset-before-light-1440.png) | [After](reset-after-light-1440.png) | [Mobile](reset-after-light-390.png) | [Dark](reset-after-dark-1440.png) | [Diff](reset-diff.png) |
| questions | [Before](questions-before-light-1440.png) | [After](questions-after-light-1440.png) | [Mobile](questions-after-light-390.png) | [Dark](questions-after-dark-1440.png) | [Diff](questions-diff.png) |
| device | [Before](device-before-light-1440.png) | [After](device-after-light-1440.png) | [Mobile](device-after-light-390.png) | [Dark](device-after-dark-1440.png) | [Diff](device-diff.png) |

No horizontal overflow at 390, 768, 1024 or 1440 pixels in either theme. [Measurements](dimensions.json)
