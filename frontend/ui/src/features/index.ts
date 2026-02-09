/**
 * Features module index
 *
 * This file exports all feature modules for easy imports.
 * Each feature module contains its own components, hooks, types, and utils.
 *
 * Note: For settings, import from specific submodules to avoid naming conflicts:
 * - '@/features/settings/project' for project settings
 * - '@/features/settings/workspace' for workspace settings
 */

export * from "./traces";
export * from "./workspaces";
export * from "./projects";
// Settings module re-exported with namespaces to avoid conflicts
export * as projectSettings from "./settings/project";
export * as workspaceSettings from "./settings/workspace";
