import { ESLint } from 'eslint';
import { describe, expect, test } from 'vitest';

describe('API review static quality gate',()=>{
  test('keeps production API source at zero ESLint errors and warnings',async()=>{
    const results=await new ESLint().lintFiles(['apps/api/src']);
    const summary=results.reduce((total,result)=>({errors:total.errors+result.errorCount,warnings:total.warnings+result.warningCount}),{errors:0,warnings:0});
    expect(summary).toEqual({errors:0,warnings:0});
  },30_000);
});
