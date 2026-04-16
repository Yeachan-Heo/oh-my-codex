import { describe, it } from 'node:test';
import { expect } from './test-helpers.js';
import { titleToSlug } from '../storage.js';

describe('titleToSlug non-ASCII support', () => {
  it('Latin titles unchanged', () => {
    expect(titleToSlug('Auth Architecture')).toBe('auth-architecture.md');
  });

  it('CJK title preserves characters in slug', () => {
    expect(titleToSlug('日本語ドキュメント')).toBe('日本語ドキュメント.md');
  });

  it('Korean title preserves characters in slug', () => {
    expect(titleToSlug('인증 아키텍처')).toBe('인증-아키텍처.md');
  });

  it('mixed Latin and CJK preserves both', () => {
    expect(titleToSlug('My 프로젝트 Setup')).toBe('my-프로젝트-setup.md');
  });

  it('empty string must not produce bare .md', () => {
    expect(titleToSlug('')).toMatch(/^page-[0-9a-f]{8}\.md$/);
  });

  it('deterministic for same input', () => {
    expect(titleToSlug('テスト')).toBe(titleToSlug('テスト'));
  });

  it('different CJK titles produce different slugs', () => {
    expect(titleToSlug('日本語')).not.toBe(titleToSlug('中文'));
  });

  it('accented Latin characters are preserved', () => {
    expect(titleToSlug('café résumé')).toBe('café-résumé.md');
  });
});
