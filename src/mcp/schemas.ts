import { z } from 'zod';

export const SearchSchema = z.object({
  query: z.string().describe('Substring to match against function/method names'),
});

export const GetSymbolSchema = z.object({
  id: z.number().optional().describe('Symbol ID'),
  name: z.string().optional().describe('Symbol name (exact match)'),
});

export const SymbolIdSchema = z.object({
  id: z.number().describe('Symbol ID'),
});

export const OptionalSymbolIdSchema = z.object({
  id: z.number().optional().describe('Symbol ID (omit for all)'),
});

export const GetAnnotationsSchema = z.object({
  symbolId: z.number().optional().describe('Filter to a specific symbol (omit for all)'),
});

export const AnnotateSchema = z.object({
  symbolId: z.number().optional().describe('Symbol ID to annotate (required for symbol annotations)'),
  target_type: z.string().optional().describe('Target type: "symbol" (default), "module", or "project"'),
  target_name: z.string().optional().describe('Target name for module/project annotations (e.g. "src/parser")'),
  tags: z.array(z.string()).describe('Semantic tags (e.g. ["auth", "deprecated"])'),
  label: z.string().describe('One-line docstring summary'),
  explanation: z.string().describe('Detailed reasoning — WHY this design choice was made'),
  author: z.string().optional().describe('Who wrote this (default: "agent")'),
  algorithmic_complexity: z.string().optional().describe('Estimated Big-O time complexity (e.g. "O(n log n)")'),
  spatial_complexity: z.string().optional().describe('Estimated data movement / memory complexity (e.g. "copies full array", "streams line-by-line", "mutates in-place")'),
  pitfalls: z.array(z.string()).optional().describe('Known edge cases, performance traps, or unexpected behaviors'),
});

export const FindRisksSchema = z.object({
  min_coupling: z.number().optional().describe('Minimum coupling score (default: 10)'),
  min_impact: z.number().optional().describe('Minimum impact radius (default: 0)'),
  min_cc: z.number().optional().describe('Minimum cyclomatic complexity (default: 0)'),
  unannotated_only: z.boolean().optional().describe('Only show functions without annotations (default: true)'),
});

export const SetArchitectureSchema = z.object({
  module: z.string().describe('Module path (e.g. "src/parser")'),
  allowed_deps: z.array(z.string()).describe('List of modules this module is allowed to depend on'),
});

export const EmptySchema = z.object({});
