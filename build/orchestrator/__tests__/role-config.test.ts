import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_ROLE_CONFIGS,
  applyEnvRoleConfig,
  cloneRoleConfigs,
  migrateLegacyModels,
} from '../role-config';

describe('role config defaults', () => {
  it('matches the default build routing', () => {
    expect(DEFAULT_ROLE_CONFIGS.testWriter).toEqual({
      provider: 'claude',
      model: 'claude-opus-4-7',
      reasoning: 'xhigh',
    });
    expect(DEFAULT_ROLE_CONFIGS.primaryImpl).toEqual({
      provider: 'gemini',
      model: 'gemini-3.1-pro',
      reasoning: 'high',
    });
    expect(DEFAULT_ROLE_CONFIGS.testFixer).toEqual({
      provider: 'codex',
      model: 'gpt-5.5',
      reasoning: 'high',
    });
    expect(DEFAULT_ROLE_CONFIGS.reviewSecondary).toEqual({
      provider: 'claude',
      model: 'claude-opus-4-7',
      reasoning: 'xhigh',
      command: '/codex review',
    });
    expect(DEFAULT_ROLE_CONFIGS.ship.command).toBe('/gstack-ship');
    expect(DEFAULT_ROLE_CONFIGS.land.command).toBe('/gstack-land-and-deploy');
  });
});

describe('role config precedence helpers', () => {
  it('applies env overrides over defaults', () => {
    const roles = applyEnvRoleConfig(cloneRoleConfigs(), {
      GSTACK_BUILD_SHIP_MODEL: 'gpt-5.4',
      GSTACK_BUILD_SHIP_REASONING: 'medium',
      GSTACK_BUILD_SHIP_COMMAND: '/custom-ship',
    });
    expect(roles.ship.model).toBe('gpt-5.4');
    expect(roles.ship.reasoning).toBe('medium');
    expect(roles.ship.command).toBe('/custom-ship');
  });

  it('migrates old model fields into roleConfigs', () => {
    const roles = migrateLegacyModels({
      geminiModel: 'gemini-legacy',
      codexModel: 'codex-legacy',
      codexReviewModel: 'review-legacy',
    });
    expect(roles.primaryImpl.model).toBe('gemini-legacy');
    expect(roles.secondaryImpl.model).toBe('codex-legacy');
    expect(roles.reviewSecondary.model).toBe('review-legacy');
  });
});
