export const dynamic = "force-dynamic";

import { requireSuperadmin } from "@/server/auth/superadmin";
import { unscopedPrisma } from "@/server/db/tenant";
import { Card, CardContent } from "@/components/ui/card";
import { StatCard } from "@/components/analytics/charts";

/**
 * Read-only internal summary (Step 20). Deliberately minimal: correctness
 * and evidence matter more than visual polish for Phase 1 -- see
 * docs/compliance/OPERATIONS.md. No mutation happens on this page.
 */
export default async function ComplianceDashboardPage() {
  await requireSuperadmin();

  const now = new Date();

  const [
    totalControls,
    implementedControls,
    partialControls,
    missingControls,
    externalVerificationRequiredControls,
    overdueControlReviews,
    staleEvidence,
    openRisks,
    openIncidents,
    subprocessorsDueReview,
    dsrApproachingDeadline,
    certifications,
  ] = await Promise.all([
    unscopedPrisma.complianceControl.count(),
    unscopedPrisma.complianceControl.count({ where: { implementationStatus: "IMPLEMENTED" } }),
    unscopedPrisma.complianceControl.count({ where: { implementationStatus: "PARTIAL" } }),
    unscopedPrisma.complianceControl.count({ where: { implementationStatus: "MISSING" } }),
    unscopedPrisma.complianceControl.count({
      where: { implementationStatus: "EXTERNAL_VERIFICATION_REQUIRED" },
    }),
    unscopedPrisma.complianceControl.count({ where: { reviewDate: { lt: now } } }),
    unscopedPrisma.complianceEvidence.count({ where: { reviewDueAt: { lt: now } } }),
    unscopedPrisma.complianceRisk.count({ where: { status: { in: ["OPEN", "MITIGATING"] } } }),
    unscopedPrisma.securityIncident.count({ where: { status: { not: "CLOSED" } } }),
    unscopedPrisma.subprocessor.count({ where: { active: true, reviewDate: { lt: now } } }),
    unscopedPrisma.dataSubjectRequest.count({
      where: { status: { in: ["RECEIVED", "IN_PROGRESS"] }, deadlineAt: { lt: now } },
    }),
    unscopedPrisma.certification.findMany({
      select: { framework: true, certificationType: true, verificationState: true },
    }),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Trust &amp; Compliance</h1>
        <p className="text-sm text-muted-foreground">
          Internal readiness overview (Issue #74, Phase 1). Not a public page. See{" "}
          <code>docs/compliance/FINLAND_BASELINE.md</code> for the full gap analysis and{" "}
          <code>docs/compliance/SECURITY_CLAIMS.md</code> before repeating any number here outside
          this tool.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Controls tracked" value={totalControls} />
        <StatCard label="Implemented" value={implementedControls} />
        <StatCard label="Partial" value={partialControls} />
        <StatCard label="Missing" value={missingControls} />
        <StatCard
          label="External verification required"
          value={externalVerificationRequiredControls}
        />
        <StatCard label="Overdue control reviews" value={overdueControlReviews} />
        <StatCard label="Stale evidence" value={staleEvidence} />
        <StatCard label="Open risks" value={openRisks} />
        <StatCard label="Open incidents" value={openIncidents} />
        <StatCard label="Subprocessor reviews due" value={subprocessorsDueReview} />
        <StatCard label="DSRs past deadline" value={dsrApproachingDeadline} />
        <StatCard label="Certifications on file" value={certifications.length} />
      </div>

      <Card>
        <CardContent className="pt-6">
          <h2 className="mb-3 text-lg font-medium">Certifications on file</h2>
          {certifications.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              None. Syveka holds no certifications as of this phase — see{" "}
              <code>docs/compliance/SECURITY_CLAIMS.md</code>.
            </p>
          ) : (
            <ul className="space-y-1 text-sm">
              {certifications.map((cert, i) => (
                <li key={i}>
                  {cert.framework} — {cert.certificationType} ({cert.verificationState})
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
