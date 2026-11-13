// packages/reactor-service/src/kairon/baseline.ts
//
// The baseline every chat turn starts from (DEV-1364): the forecast version,
// the approved version (the promise to investors), both evaluated with an
// empty body, the closed month and the derived lines as the server reports
// them, the milestones, and a digest of the plan for the LLM.

import { z } from 'zod';
import { planOf, type KaironApi, type KaironMilestone, type KaironVersion } from './client.js';
import { addMonths, type ForecastDocument, type ForecastPlan } from './patch.js';
import { summarizeEvaluation, type EvaluationMetrics } from './summary.js';

export interface LineDigest {
  code: string;
  name: string;
  groupCode: string | null;
  totalMinor: string;
  closedTotalMinor: string;
  /** Non-zero cells after the closed month; the months a patch may change. */
  openCells: Record<string, string>;
}

export interface Baseline {
  project: { id: string; name: string; currencyCode: string; decimals: number };
  forecastVersion: { id: string; name: string };
  approvedVersion: { id: string; name: string };
  closedThrough: string;
  derivedLineCodes: string[];
  monthRange: { from: string; to: string };
  milestones: KaironMilestone[];
  approved: EvaluationMetrics;
  active: EvaluationMetrics;
  lines: LineDigest[];
}

const BoundaryShape = z.object({
  factBoundary: z.object({ month: z.string().nullable() }).nullable(),
  derivedLines: z.object({ lines: z.array(z.object({ code: z.string() })) }),
});

export function digestLines(plan: ForecastPlan, closedThrough: string): LineDigest[] {
  return plan.lines.map((line) => {
    let total = 0n;
    let closed = 0n;
    const openCells: Record<string, string> = {};
    for (const month of Object.keys(line.monthlyForecast).sort()) {
      const value = BigInt(line.monthlyForecast[month] ?? '0');
      total += value;
      if (month <= closedThrough) closed += value;
      else if (value !== 0n) openCells[month] = String(value);
    }
    return {
      code: line.code,
      name: line.name,
      groupCode: typeof line.groupCode === 'string' ? line.groupCode : null,
      totalMinor: String(total),
      closedTotalMinor: String(closed),
      openCells,
    };
  });
}

export function pickForecastVersion(versions: KaironVersion[], pinnedId: string | undefined): KaironVersion {
  const picked = pinnedId === undefined ? versions.find((v) => v.isActive) : versions.find((v) => v.id === pinnedId);
  if (picked === undefined) throw new Error(`Forecast version not found: ${pinnedId ?? 'no active version'}`);
  return picked;
}

export async function loadDocument(api: KaironApi, versionId: string): Promise<ForecastDocument> {
  const version = (await api.listVersions()).find((v) => v.id === versionId);
  if (version === undefined) throw new Error(`Forecast version not found: ${versionId}`);
  return { plan: planOf(version) };
}

export async function readBaseline(api: KaironApi): Promise<Baseline> {
  const [project, versions] = await Promise.all([api.getProject(), api.listVersions()]);
  const forecast = pickForecastVersion(versions, api.pinnedVersionId);
  const approved = versions.find((v) => v.id === project.currentApprovedVersionId);
  if (approved === undefined) {
    throw new Error('The project has no current approved version, so the promise to investors is unknown');
  }
  const [activeRes, approvedRes, milestones] = await Promise.all([
    api.evaluate(forecast.id, {}),
    api.evaluate(approved.id, {}),
    api.getMilestones(forecast.id),
  ]);
  if (activeRes.status !== 200 || approvedRes.status !== 200) {
    throw new Error(`Baseline evaluate failed: forecast ${activeRes.status}, approved ${approvedRes.status}`);
  }
  const plan = planOf(forecast);
  const bounds = BoundaryShape.parse(activeRes.json);
  const closedThrough = bounds.factBoundary?.month ?? addMonths(plan.monthRange.from, -1);
  return {
    project: {
      id: project.id,
      name: project.name,
      currencyCode: project.currency.code,
      decimals: project.currency.decimals,
    },
    forecastVersion: { id: forecast.id, name: forecast.name },
    approvedVersion: { id: approved.id, name: approved.name },
    closedThrough,
    derivedLineCodes: bounds.derivedLines.lines.map((l) => l.code),
    monthRange: plan.monthRange,
    milestones,
    approved: summarizeEvaluation(approvedRes.json),
    active: summarizeEvaluation(activeRes.json),
    lines: digestLines(plan, closedThrough),
  };
}
